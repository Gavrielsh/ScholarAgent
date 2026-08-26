import { isUniqueViolation, query } from "@/lib/core/db";
import {
  MAX_PRIVILEGE_LEVEL,
  MIN_CORPUS_WRITE_LEVEL,
  type AccessLevel,
} from "@/lib/core/db/accessLevel";
import { logError, logInfo } from "@/lib/core/logger";

// ---------------------------------------------------------------------------
// Permission model
// ---------------------------------------------------------------------------

// Four-tier authorization model (L0=Admin, L3=Volunteer).
// Alias of the persistence layer's access-level contract: the two are the same
// numbers, so core can scope a transaction without importing from security.
export type PermissionLevel = AccessLevel;

export const PERMISSION_ROLE: Record<PermissionLevel, string> = {
  0: "Admin",
  1: "Manager",
  2: "Staff",
  3: "Volunteer",
};

export const ROLE_DESCRIPTIONS: Record<PermissionLevel, string> = {
  0: "Headquarters staff: full situational picture, technical details, cross-project analytics, and strategic oversight.",
  1: "Training managers: professional guidance, pedagogical insights, operational summaries, and management-oriented recommendations.",
  2: "Students/counselors: logistics support, discipline protocols, and behavioral insights for specific mentor-mentee pairs.",
  3: "Mentors/alumni: practical on-the-ground tips, activity ideas, and crisis-management guidance in simple, actionable Hebrew.",
};

export interface UserContext {
  userId: string;
  permissionLevel: PermissionLevel;
  roleName: string;
  organizationId?: string;
}

// A knowledge-base chunk carries the minimum permission level required to access it.
// classificationLevel=0 → admin-only; classificationLevel=3 → lowest registered tier.
export interface KnowledgeChunk {
  id: string;
  content: string;
  classificationLevel: PermissionLevel;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// RLS level constants
// ---------------------------------------------------------------------------

export const ADMIN_PERMISSION_LEVEL: PermissionLevel = MAX_PRIVILEGE_LEVEL;
export const MANAGER_PERMISSION_LEVEL: PermissionLevel = MIN_CORPUS_WRITE_LEVEL;

// ---------------------------------------------------------------------------
// Role predicates
// ---------------------------------------------------------------------------

/** L0 Admin — full access, including every user's chat history. */
export function isAdminRole(level: PermissionLevel): boolean {
  return level === ADMIN_PERMISSION_LEVEL;
}

/** L1 Manager — staff-scoped operational access. */
export function isManagerRole(level: PermissionLevel): boolean {
  return level === MANAGER_PERMISSION_LEVEL;
}

/** L0 Admin or L1 Manager — elevated operational access. */
export function isElevatedRole(level: PermissionLevel): boolean {
  return isAdminRole(level) || isManagerRole(level);
}

/**
 * Whether the caller bypasses the **privacy** guardrails (identity lookups,
 * personal-data requests, negative-targeting rewrites).
 *
 * L0/L1 run legitimate cross-user analytics, so blocking those queries would
 * break the admin reporting flows by design.
 *
 * This does NOT and MUST NOT gate distress detection. Distress handoff runs for
 * every tier without exception: an L1 training manager relaying a child's
 * message is one of the likeliest paths for a crisis to reach this system, and
 * the previous `shouldSkipGuardrails` silently excluded exactly that case.
 * See `evaluateInboundSafety` in lib/security/guardrails/safetySignals.ts.
 */
export function shouldSkipPrivacyGuardrails(user: UserContext): boolean {
  return isElevatedRole(user.permissionLevel);
}

// ---------------------------------------------------------------------------
// RBAC authorization checks
// ---------------------------------------------------------------------------

// A user may access a chunk when their permission level is <= the chunk's classification level.
// (Lower numeric level = higher privilege, so Admin L0 can access all levels 0-3.)
function canAccessChunk(user: UserContext, chunk: KnowledgeChunk): boolean {
  return user.permissionLevel <= chunk.classificationLevel;
}

// Filter a list of retrieved chunks to only those the user is authorised to see.
export function filterAuthorizedChunks(
  user: UserContext,
  chunks: KnowledgeChunk[]
): KnowledgeChunk[] {
  return chunks.filter((chunk) => canAccessChunk(user, chunk));
}

// Enforce a minimum required role for an operation; throws if the user lacks access.
export function assertMinimumLevel(user: UserContext, requiredLevel: PermissionLevel): void {
  if (user.permissionLevel > requiredLevel) {
    throw new Error(
      `Access denied: operation requires permission level ≤ ${requiredLevel}, user has ${user.permissionLevel}.`
    );
  }
}

/**
 * Whether a user may publish content classified at `classificationLevel`.
 *
 * Lower numeric level = higher privilege, so classifying *below* one's own
 * level would publish content the author is not cleared to read — an L1
 * Manager marking a document L0 (admin-only), for instance.
 */
export function canClassifyAtLevel(
  user: UserContext,
  classificationLevel: PermissionLevel
): boolean {
  return classificationLevel >= user.permissionLevel;
}

// ---------------------------------------------------------------------------
// User registry
// ---------------------------------------------------------------------------

interface UserRow {
  id: string;
  phone_number: string;
  permission_level: PermissionLevel;
  organization_id: string | null;
}

function redactPhone(phoneNumber: string): string {
  if (phoneNumber.length <= 4) return "****";
  return `${phoneNumber.slice(0, 3)}***${phoneNumber.slice(-2)}`;
}

function toUserContext(row: UserRow): UserContext | null {
  if (!(row.permission_level in PERMISSION_ROLE)) {
    logError("user_registry_invalid_permission_level", new Error("invalid permission_level"), {
      userId: row.id,
      permissionLevel: row.permission_level,
    });
    return null;
  }

  return {
    userId: row.id,
    permissionLevel: row.permission_level,
    roleName: PERMISSION_ROLE[row.permission_level],
    organizationId: row.organization_id ?? undefined,
  };
}

// Thrown when the DB is unreachable — distinguishes infrastructure failures
// from genuine "phone not registered" cases so callers can respond differently.
export class UserRegistryDbError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "DB lookup failed");
    this.name = "UserRegistryDbError";
    if (cause instanceof Error && cause.stack) {
      this.stack = cause.stack;
    }
  }
}

// Look up a WhatsApp sender's permission level from the `users` table.
// Returns null  → phone not registered (send UNAUTHORIZED_MESSAGE).
// Throws UserRegistryDbError → DB unreachable (send a "try again" message, not "unauthorized").
export async function lookupUserByPhone(phoneNumber: string): Promise<UserContext | null> {
  let result;
  try {
    result = await query<UserRow>(
      `SELECT id, phone_number, permission_level, organization_id
         FROM users
        WHERE phone_number = $1
        LIMIT 1;`,
      [phoneNumber]
    );
  } catch (err) {
    logError("user_registry_lookup_failed", err, { phone: redactPhone(phoneNumber) });
    throw new UserRegistryDbError(err);
  }

  const row = result.rows[0];
  if (!row) {
    logInfo("user_registry_phone_not_found", "Phone is not registered.", {
      phone: redactPhone(phoneNumber),
    });
    return null;
  }

  const context = toUserContext(row);
  if (context) {
    logInfo("user_registry_resolved", "Sender mapped to a registered role.", {
      phone: redactPhone(phoneNumber),
      permissionLevel: context.permissionLevel,
      roleName: context.roleName,
    });
  }
  return context;
}

/** JWT `sub` lookup used by HTTP upload auth. Returns null when the id is unknown. */
export async function lookupUserById(userId: string): Promise<UserContext | null> {
  let result;
  try {
    result = await query<UserRow>(
      `SELECT id, phone_number, permission_level, organization_id
         FROM users
        WHERE id = $1
        LIMIT 1;`,
      [userId]
    );
  } catch (err) {
    logError("user_registry_lookup_by_id_failed", err, { userId });
    throw new UserRegistryDbError(err);
  }

  const row = result.rows[0];
  if (!row) return null;
  return toUserContext(row);
}

export function normalizePhoneNumber(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (!digits) return null;

  let normalized = digits;
  if (normalized.startsWith("00")) {
    normalized = normalized.slice(2);
  }
  if (normalized.startsWith("0") && normalized.length >= 9 && normalized.length <= 11) {
    normalized = `972${normalized.slice(1)}`;
  }

  if (normalized.length < 8 || normalized.length > 15) return null;
  return normalized;
}

function asPermissionLevel(value: number): PermissionLevel | null {
  if (value === 0 || value === 1 || value === 2 || value === 3) return value;
  return null;
}

export interface ManagedUserRecord {
  phone_number: string;
  display_name: string;
  permission_level: PermissionLevel;
}

export async function insertAdminManagedUser(
  phone: string,
  name: string,
  level: number
): Promise<boolean> {
  const normalized = normalizePhoneNumber(phone);
  const permissionLevel = asPermissionLevel(level);
  const displayName = name.trim();
  if (!normalized || permissionLevel === null || !displayName) return false;

  try {
    const result = await query(
      `INSERT INTO users (phone_number, display_name, permission_level, organization_id)
       VALUES ($1, $2, $3, NULL)`,
      [normalized, displayName, permissionLevel]
    );
    return (result.rowCount ?? 0) > 0;
  } catch (err) {
    if (isUniqueViolation(err)) {
      logInfo("user_registry_insert_duplicate", "Phone already registered.", {
        phone: redactPhone(normalized),
      });
      return false;
    }
    logError("user_registry_insert_failed", err, { phone: redactPhone(normalized) });
    throw new UserRegistryDbError(err);
  }
}

export async function deleteAdminManagedUser(phone: string): Promise<boolean> {
  const normalized = normalizePhoneNumber(phone);
  if (!normalized) return false;

  try {
    const result = await query(`DELETE FROM users WHERE phone_number = $1`, [normalized]);
    return (result.rowCount ?? 0) > 0;
  } catch (err) {
    logError("user_registry_delete_failed", err, { phone: redactPhone(normalized) });
    throw new UserRegistryDbError(err);
  }
}

export async function getAllManagedUsers(): Promise<ManagedUserRecord[]> {
  try {
    const result = await query<{
      phone_number: string;
      display_name: string | null;
      permission_level: number;
    }>(
      `SELECT phone_number, display_name, permission_level
         FROM users
        ORDER BY permission_level ASC, display_name ASC NULLS LAST, phone_number ASC`
    );
    return result.rows.flatMap((row) => {
      const permissionLevel = asPermissionLevel(row.permission_level);
      if (permissionLevel === null) return [];
      return [
        {
          phone_number: row.phone_number,
          display_name: row.display_name ?? "",
          permission_level: permissionLevel,
        },
      ];
    });
  } catch (err) {
    logError("user_registry_list_failed", err);
    throw new UserRegistryDbError(err);
  }
}

export async function getUserByPhone(
  phone: string
): Promise<{ permission_level: PermissionLevel } | null> {
  const normalized = normalizePhoneNumber(phone);
  if (!normalized) return null;

  try {
    const result = await query<{ permission_level: number }>(
      `SELECT permission_level FROM users WHERE phone_number = $1 LIMIT 1`,
      [normalized]
    );
    const row = result.rows[0];
    if (!row) return null;
    const permissionLevel = asPermissionLevel(row.permission_level);
    if (permissionLevel === null) return null;
    return { permission_level: permissionLevel };
  } catch (err) {
    logError("user_registry_get_by_phone_failed", err, { phone: redactPhone(normalized) });
    throw new UserRegistryDbError(err);
  }
}

export const adminAddUser = insertAdminManagedUser;
export const adminDeleteUser = deleteAdminManagedUser;
