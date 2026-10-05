-- migrate:up
-- Preserve opaque legacy ownership separately. Even a coincidental auth ID
-- match is not an assignment; only the reviewed administration transaction is.
ALTER TABLE product.threads RENAME COLUMN owner_id TO legacy_owner_id;
ALTER TABLE product.threads ALTER COLUMN legacy_owner_id DROP NOT NULL;
ALTER TABLE product.threads ADD COLUMN owner_id text REFERENCES auth."user"(id);
ALTER TABLE product.threads ADD COLUMN title text NOT NULL DEFAULT 'New conversation';
ALTER TABLE product.threads ADD COLUMN creation_title text NOT NULL DEFAULT 'New conversation';
ALTER TABLE product.threads ADD COLUMN archived_at timestamptz;
-- NOT VALID retains historical rows but checks every new insert/update.
ALTER TABLE product.threads ADD CONSTRAINT thread_requires_identity CHECK (owner_id IS NOT NULL) NOT VALID;
CREATE INDEX threads_owner_created ON product.threads(owner_id, created_at, thread_id);

-- migrate:down
ALTER TABLE product.threads DROP CONSTRAINT thread_requires_identity;
DROP INDEX product.threads_owner_created;
ALTER TABLE product.threads DROP COLUMN archived_at;
ALTER TABLE product.threads DROP COLUMN creation_title;
ALTER TABLE product.threads DROP COLUMN title;
ALTER TABLE product.threads DROP COLUMN owner_id;
ALTER TABLE product.threads RENAME COLUMN legacy_owner_id TO owner_id;
