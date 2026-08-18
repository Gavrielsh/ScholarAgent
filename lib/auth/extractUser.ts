import type { NextRequest } from "next/server";
import { createRemoteJWKSet, jwtVerify } from "jose";

import { lookupUserById } from "@/lib/auth/userRegistry";
import type { PermissionLevel, UserContext } from "@/lib/auth/types";

const VALID_LEVELS: ReadonlySet<number> = new Set([0, 1, 2, 3]);
let cachedJwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let cachedJwksUrl: string | null = null;

export class UnauthenticatedError extends Error {
  constructor(message = "חסר או לא תקין אסימון אימות.") {
    super(message);
    this.name = "UnauthenticatedError";
  }
}

type SupabaseJwtPayload = {
  sub?: string;
  role?: string;
  permission_level?: number | string;
  role_name?: string;
  app_metadata?: {
    permission_level?: number | string;
    role_name?: string;
  };
  user_metadata?: {
    organization_id?: string;
  };
};

function getBearerToken(request: NextRequest): string {
  const auth = request.headers.get("authorization");
  if (!auth) {
    throw new UnauthenticatedError("חסר כותרת Authorization.");
  }

  const [scheme, token] = auth.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) {
    throw new UnauthenticatedError("פורמט Authorization אינו תקין.");
  }
  return token;
}

/**
 * Authorization claims come from service-role-writable `app_metadata` (or a
 * top-level custom claim). `user_metadata` is end-user writable in Supabase and
 * must never grant privilege.
 */
function parsePermissionLevel(payload: SupabaseJwtPayload): PermissionLevel {
  const raw = payload.permission_level ?? payload.app_metadata?.permission_level;
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isInteger(parsed) || !VALID_LEVELS.has(parsed)) {
    throw new UnauthenticatedError("permission_level לא נמצא או אינו תקין באסימון.");
  }
  return parsed as PermissionLevel;
}

function parseRoleName(payload: SupabaseJwtPayload, permissionLevel: PermissionLevel): string {
  const roleFromClaims = payload.role_name ?? payload.app_metadata?.role_name;
  return roleFromClaims?.trim() || payload.role || `L${permissionLevel}`;
}

function supabaseIssuerUrl(): string {
  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL)?.trim();
  if (!url) {
    throw new UnauthenticatedError("חסר SUPABASE_URL להגדרת אימות.");
  }
  return `${url.replace(/\/+$/, "")}/auth/v1`;
}

async function verifySupabaseToken(token: string) {
  const jwtSecret = process.env.SUPABASE_JWT_SECRET;
  const issuer = supabaseIssuerUrl();
  const audience = "authenticated";

  if (jwtSecret) {
    return jwtVerify(token, new TextEncoder().encode(jwtSecret), {
      issuer,
      audience,
      algorithms: ["HS256"],
    });
  }

  const jwksUrl = `${issuer}/.well-known/jwks.json`;
  if (!cachedJwks || cachedJwksUrl !== jwksUrl) {
    cachedJwks = createRemoteJWKSet(new URL(jwksUrl));
    cachedJwksUrl = jwksUrl;
  }
  const jwks = cachedJwks;
  return jwtVerify(token, jwks, { issuer, audience });
}

export async function extractUserContext(request: NextRequest): Promise<UserContext> {
  const token = getBearerToken(request);
  const verified = await verifySupabaseToken(token);
  const payload = verified.payload as SupabaseJwtPayload;
  const userId = payload.sub;
  if (!userId) {
    throw new UnauthenticatedError("אסימון Supabase אינו כולל מזהה משתמש (sub).");
  }

  const fromDb = await lookupUserById(userId);
  if (fromDb) {
    return fromDb;
  }

  const permissionLevel = parsePermissionLevel(payload);
  const roleName = parseRoleName(payload, permissionLevel);
  const organizationId = payload.user_metadata?.organization_id;
  return {
    userId,
    permissionLevel,
    roleName,
    organizationId,
  };
}
