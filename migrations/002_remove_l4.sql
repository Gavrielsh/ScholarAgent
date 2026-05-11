-- Migration 002: remove L4 / Guest access level

UPDATE knowledge_base
   SET classification_level = 3
 WHERE classification_level = 4;

UPDATE users
   SET permission_level = 3
 WHERE permission_level = 4;

ALTER TABLE knowledge_base
  ALTER COLUMN classification_level SET DEFAULT 3;

ALTER TABLE users
  ALTER COLUMN permission_level SET DEFAULT 3;

ALTER TABLE knowledge_base
  DROP CONSTRAINT IF EXISTS knowledge_base_classification_level_check;

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_permission_level_check;

ALTER TABLE knowledge_base
  ADD CONSTRAINT knowledge_base_classification_level_check
  CHECK (classification_level BETWEEN 0 AND 3);

ALTER TABLE users
  ADD CONSTRAINT users_permission_level_check
  CHECK (permission_level BETWEEN 0 AND 3);

INSERT INTO schema_migrations (version) VALUES ('002_remove_l4')
  ON CONFLICT (version) DO NOTHING;
