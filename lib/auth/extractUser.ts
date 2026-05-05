import type { NextRequest } from "next/server";

import type { PermissionLevel, UserContext } from "@/lib/auth/types";

// TODO: Replace this header-based stub with a proper auth strategy
//       (e.g. NextAuth.js JWT, Clerk session, or Supabase Auth) before
//       deploying outside the research environment.
//
// Current contract — request must include:
//   x-user-id: <uuid>
//   x-user-permission-level: 0|1|2|3|4
//   x-organization-id: <uuid>   (optional)

const VALID_LEVELS: ReadonlySet<number> = new Set([0, 1, 2, 3, 4]);

export class UnauthenticatedError extends Error {
  constructor(message = "Missing or invalid authentication headers.") {
    super(message);
    this.name = "UnauthenticatedError";
  }
}

export function extractUserContext(request: NextRequest): UserContext {
  const userId = request.headers.get("x-user-id");
  const levelRaw = request.headers.get("x-user-permission-level");
  const organizationId = request.headers.get("x-organization-id") ?? undefined;

  if (!userId) {
    throw new UnauthenticatedError("Missing x-user-id header.");
  }

  if (levelRaw === null) {
    throw new UnauthenticatedError("Missing x-user-permission-level header.");
  }

  const parsed = Number.parseInt(levelRaw, 10);
  if (!Number.isInteger(parsed) || !VALID_LEVELS.has(parsed)) {
    throw new UnauthenticatedError(
      `Invalid permission level "${levelRaw}". Must be one of 0, 1, 2, 3, 4.`
    );
  }

  return {
    userId,
    permissionLevel: parsed as PermissionLevel,
    organizationId,
  };
}
