-- =============================================================================
-- 003_enforce_rls_role.sql — make row-level security actually apply
-- =============================================================================
-- NUMBERING: this is 003, not 002. migrations/002_knowledge_gaps.sql exists on
-- the feat/knowledge-gaps branch (PR #17). Two files numbered 002 would both
-- apply, in filename order, with nothing to say which came first. 003 keeps the
-- sequence unambiguous whichever branch merges first.
--
-- ORDER INDEPENDENCE: this file grants on all tables that exist now AND sets
-- default privileges for tables created later, so it is correct whether it runs
-- before or after 002_knowledge_gaps.
--
-- =============================================================================
-- Why this migration exists
-- =============================================================================
-- 001_initial_schema.sql enables and FORCEs row-level security on
-- knowledge_base, ingested_documents and chat_history, and its own comment is
-- explicit about the limit:
--
--   "FORCE RLS applies policies to the table owner as well
--    (superuser / BYPASSRLS still bypass)."
--
-- The policies were therefore never evaluated, because the application was
-- connecting as a SUPERUSER. In PostgreSQL a role with rolsuper or
-- rolbypassrls skips every policy no matter what FORCE ROW LEVEL SECURITY
-- says. Empirically: all five seeded canaries at L0/L1 were retrievable from
-- L1/L2, i.e. every tier could read every tier.
--
-- The local cause is the Postgres Docker entrypoint: it creates POSTGRES_USER
-- as a SUPERUSER, so docker-compose's `user` role bypasses RLS by
-- construction. The same hole exists on any managed database where the
-- application's connection role happens to be a superuser or carries
-- BYPASSRLS, so this is not only a local-development problem.
--
-- The fix is a role with no way to bypass. withRlsTransaction and
-- withSenderTransaction in lib/core/db.ts now issue
-- `SET LOCAL ROLE scholaragent_app` inside the transaction, so policies are
-- evaluated against this role rather than against the connecting superuser.
-- SET LOCAL is transaction-scoped: it reverts on COMMIT or ROLLBACK and cannot
-- leak onto the next user of a pooled connection.
--
-- The deliberately unchanged escape hatch is withServiceClient, which uses a
-- separate pool and never switches role. That is what the evaluation harness's
-- positive control needs in order to prove a canary is reachable at all.
-- =============================================================================


-- =============================================================================
-- 1. The unprivileged role
-- =============================================================================
-- NOLOGIN is intentional: nothing ever connects as this role, it is only
-- entered via SET LOCAL ROLE from the connecting user. That keeps the number of
-- credentials unchanged.
--
-- The stronger arrangement is for the application to connect as this role
-- directly (LOGIN plus a password, and no superuser anywhere in the path).
-- SET LOCAL ROLE is chosen here because it needs no new secret, no connection
-- string change, and no coordinated deploy — and because a superuser that
-- immediately drops to a NOBYPASSRLS role is equivalent for policy evaluation.
--
-- ALTER on the else branch is not redundant: a pre-existing role of this name
-- might have been created with BYPASSRLS, which would silently reinstate the
-- exact bug this migration fixes.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'scholaragent_app') THEN
    CREATE ROLE scholaragent_app
      NOLOGIN
      NOSUPERUSER
      NOBYPASSRLS
      NOCREATEDB
      NOCREATEROLE
      NOREPLICATION;
  ELSE
    ALTER ROLE scholaragent_app
      NOLOGIN
      NOSUPERUSER
      NOBYPASSRLS
      NOCREATEDB
      NOCREATEROLE
      NOREPLICATION;
  END IF;
END
$$;

COMMENT ON ROLE scholaragent_app IS
  'Unprivileged application role. Entered via SET LOCAL ROLE so RLS policies '
  'are evaluated instead of being bypassed by a superuser connection. '
  'Must never hold SUPERUSER or BYPASSRLS.';


-- =============================================================================
-- 2. Privileges
-- =============================================================================
-- RLS restricts WHICH ROWS are visible; it does not grant table access. Without
-- these the role would be denied outright rather than filtered.

GRANT USAGE ON SCHEMA public TO scholaragent_app;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON ALL TABLES IN SCHEMA public
  TO scholaragent_app;

GRANT USAGE, SELECT
  ON ALL SEQUENCES IN SCHEMA public
  TO scholaragent_app;

-- Future tables and sequences. Default privileges attach to objects created by
-- the role that runs this statement, which is the role the migration runner
-- connects as — the same role that will create later tables. A migration
-- applied by a DIFFERENT role will not be covered, so any future migration that
-- adds a table should re-run the GRANT block above.

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO scholaragent_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO scholaragent_app;

-- Least privilege: migration bookkeeping is the runner's business, and the
-- runner connects as the owner, never as this role. Read is left in place so a
-- diagnostic query under the app role can still report schema state.
REVOKE INSERT, UPDATE, DELETE ON schema_migrations FROM scholaragent_app;

-- SET ROLE requires membership in the target role. Granted to whichever role is
-- applying this migration, which is the role the connection pool uses.
-- Idempotent: re-granting an existing membership is a no-op.
DO $$
BEGIN
  EXECUTE format('GRANT scholaragent_app TO %I', current_user);
END
$$;


-- =============================================================================
-- 3. Re-assert FORCE ROW LEVEL SECURITY
-- =============================================================================
-- Already set by 001. Re-asserted because it is idempotent and because this is
-- the file someone will read when asking whether enforcement is on. FORCE makes
-- policies apply to the table owner too, which matters now that a real
-- non-owner role is doing the reading.
--
-- These three tables are the RLS-protected set as of this migration. A later
-- migration that adds a table holding tier-sensitive rows must enable and force
-- RLS on it and write its own policies; neither this file nor the GRANTs above
-- will do it. Note that knowledge_gaps, added by 002_knowledge_gaps.sql, has no
-- RLS and no policies — that is a decision for whoever adds its reporting layer.

ALTER TABLE knowledge_base       ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_base       FORCE  ROW LEVEL SECURITY;

ALTER TABLE ingested_documents   ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingested_documents   FORCE  ROW LEVEL SECURITY;

ALTER TABLE chat_history         ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_history         FORCE  ROW LEVEL SECURITY;


-- =============================================================================
-- 4. Self-check
-- =============================================================================
-- Fails the migration rather than leaving a role that cannot enforce anything.
-- run.ts applies each file as one implicit transaction, so a RAISE here rolls
-- the whole migration back and nothing is stamped.

DO $$
DECLARE
  bad_role   text;
  unforced   text;
BEGIN
  SELECT rolname INTO bad_role
    FROM pg_roles
   WHERE rolname = 'scholaragent_app'
     AND (rolsuper OR rolbypassrls);

  IF bad_role IS NOT NULL THEN
    RAISE EXCEPTION
      'scholaragent_app holds SUPERUSER or BYPASSRLS; RLS would not be enforced.';
  END IF;

  SELECT string_agg(c.relname, ', ') INTO unforced
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname IN ('knowledge_base', 'ingested_documents', 'chat_history')
     AND NOT (c.relrowsecurity AND c.relforcerowsecurity);

  IF unforced IS NOT NULL THEN
    RAISE EXCEPTION 'FORCE ROW LEVEL SECURITY is not active on: %', unforced;
  END IF;
END
$$;


-- =============================================================================
-- 5. Stamp
-- =============================================================================
-- run.ts does NOT record a version after applying a file; each migration stamps
-- itself, as 001_initial_schema.sql does. Without this the file re-applies on
-- every `npm run migrate`.

INSERT INTO schema_migrations (version) VALUES ('003_enforce_rls_role')
  ON CONFLICT (version) DO NOTHING;
