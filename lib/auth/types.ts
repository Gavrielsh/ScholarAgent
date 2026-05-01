// Five-tier authorization model per thesis proposal (L0=Admin, L4=Guest).
export type PermissionLevel = 0 | 1 | 2 | 3 | 4;

export const PERMISSION_ROLE: Record<PermissionLevel, string> = {
  0: "Admin",
  1: "Manager",
  2: "Staff",
  3: "Volunteer",
  4: "Guest",
};

export interface UserContext {
  userId: string;
  permissionLevel: PermissionLevel;
  organizationId?: string;
}

// A knowledge-base chunk carries the minimum permission level required to access it.
// classificationLevel=0 → admin-only; classificationLevel=4 → public.
export interface KnowledgeChunk {
  id: string;
  content: string;
  classificationLevel: PermissionLevel;
  metadata?: Record<string, unknown>;
}
