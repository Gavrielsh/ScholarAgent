import type { PermissionLevel } from "@/lib/auth/types";

// Builds the WHERE clause fragment that enforces Row-Level Security.
// Assumes the knowledge_base table has a `classification_level` integer column.
//
// Rule: a row is visible when classification_level >= user's permission level.
// Admin (L0) → classification_level >= 0 → sees everything.
// Guest (L4) → classification_level >= 4 → sees only public rows.
export function buildRlsWhereClause(permissionLevel: PermissionLevel): string {
  return `classification_level >= ${permissionLevel}`;
}

// Returns the full RLS-aware similarity search query.
// Parameterised: $1 = query embedding vector, $2 = result limit.
export function buildRlsVectorSearchSql(permissionLevel: PermissionLevel): string {
  return `
    SELECT id, content, metadata, classification_level,
           1 - (embedding <=> $1::vector) AS similarity
    FROM knowledge_base
    WHERE ${buildRlsWhereClause(permissionLevel)}
    ORDER BY embedding <=> $1::vector
    LIMIT $2;
  `.trim();
}

// Schema definition for the knowledge_base table (for reference during migrations).
export const KNOWLEDGE_BASE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS knowledge_base (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content     TEXT NOT NULL,
    metadata    JSONB,
    classification_level INTEGER NOT NULL DEFAULT 4,
    embedding   vector(1536),
    created_at  TIMESTAMPTZ DEFAULT now()
  );

  -- RLS policy: each row is visible only to sessions whose app.user_permission_level <= classification_level.
  ALTER TABLE knowledge_base ENABLE ROW LEVEL SECURITY;

  CREATE POLICY rls_knowledge_access ON knowledge_base
    FOR SELECT
    USING (
      classification_level >= current_setting('app.user_permission_level')::integer
    );
`.trim();
