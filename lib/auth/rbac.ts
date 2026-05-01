import type { KnowledgeChunk, PermissionLevel, UserContext } from "@/lib/auth/types";

// A user may access a chunk when their permission level is <= the chunk's classification level.
// (Lower numeric level = higher privilege, so Admin L0 can access all levels 0-4.)
export function canAccessChunk(user: UserContext, chunk: KnowledgeChunk): boolean {
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
