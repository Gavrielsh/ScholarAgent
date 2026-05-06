import type { NextRequest } from "next/server";
import { createRemoteJWKSet, jwtVerify } from "jose";

import type { PermissionLevel, UserContext } from "@/lib/auth/types";

const VALID_LEVELS: ReadonlySet<number> = new Set([0, 1, 2, 3, 4]);

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
    permission_level?: number | string;
    role_name?: string;
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

function parsePermissionLevel(payload: SupabaseJwtPayload): PermissionLevel {
  const raw =
    payload.permission_level ??
    payload.app_metadata?.permission_level ??
    payload.user_metadata?.permission_level;
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isInteger(parsed) || !VALID_LEVELS.has(parsed)) {
    throw new UnauthenticatedError("permission_level לא נמצא או אינו תקין באסימון.");
  }
  return parsed as PermissionLevel;
}

function parseRoleName(payload: SupabaseJwtPayload, permissionLevel: PermissionLevel): string {
  const roleFromClaims =
    payload.role_name ?? payload.app_metadata?.role_name ?? payload.user_metadata?.role_name;
  return roleFromClaims?.trim() || payload.role || `L${permissionLevel}`;
}

async function verifySupabaseToken(token: string) {
  const jwtSecret = process.env.SUPABASE_JWT_SECRET;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const issuer = url ? `${url}/auth/v1` : undefined;

  if (jwtSecret) {
    return jwtVerify(token, new TextEncoder().encode(jwtSecret), {
      issuer,
      algorithms: ["HS256"],
    });
  }

  if (!url) {
    throw new UnauthenticatedError("חסר SUPABASE_JWT_SECRET וגם SUPABASE_URL להגדרת אימות.");
  }
  const jwks = createRemoteJWKSet(new URL(`${url}/auth/v1/.well-known/jwks.json`));
  return jwtVerify(token, jwks, issuer ? { issuer } : undefined);
}

export async function extractUserContext(request: NextRequest): Promise<UserContext> {
  const token = getBearerToken(request);
  const verified = await verifySupabaseToken(token);
  const payload = verified.payload as SupabaseJwtPayload;
  const userId = payload.sub;
  if (!userId) {
    throw new UnauthenticatedError("אסימון Supabase אינו כולל מזהה משתמש (sub).");
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
