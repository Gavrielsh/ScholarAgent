// Four-tier authorization model (L0=Admin, L3=Volunteer).
export type PermissionLevel = 0 | 1 | 2 | 3;

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
