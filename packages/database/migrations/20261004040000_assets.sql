-- migrate:up
-- Global IDs are never silently reassigned when the two old namespaces merge.
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM product.materials m JOIN product.artifacts a ON a.artifact_id = m.material_id) THEN
  RAISE EXCEPTION 'Asset identity collision requires explicit remediation';
 END IF;
END $$;
CREATE TABLE product.assets (
 asset_id uuid PRIMARY KEY,
 thread_id uuid NOT NULL REFERENCES product.threads(thread_id),
 source text NOT NULL CHECK(source IN ('upload', 'generated')),
 name text NOT NULL,
 mime_type text NOT NULL,
 byte_length integer NOT NULL CHECK(byte_length >= 0 AND byte_length <= 16777216),
 sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 object_key text NOT NULL UNIQUE,
 ready_at timestamptz,
 run_id uuid,
 message_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(thread_id, asset_id),
 FOREIGN KEY(thread_id, message_id) REFERENCES product.messages(thread_id, message_id),
 CHECK((source = 'upload' AND run_id IS NULL AND message_id IS NULL)
    OR (source = 'generated' AND run_id IS NOT NULL AND message_id IS NOT NULL AND ready_at IS NOT NULL)),
 -- Historical keys remain readable; new allocations use the unified namespace.
 CHECK((source = 'upload' AND object_key IN (
    'materials/' || thread_id::text || '/' || asset_id::text,
    'assets/uploads/' || thread_id::text || '/' || asset_id::text))
 OR (source = 'generated' AND object_key ~ (
    '^(artifacts|assets/generated)/' || thread_id::text || '/' || run_id::text || '/[1-9][0-9]*/' || asset_id::text || '$')))
);
CREATE TABLE product.message_assets (
 thread_id uuid NOT NULL,
 message_id uuid NOT NULL,
 asset_id uuid NOT NULL,
 position integer NOT NULL CHECK(position >= 0 AND position < 32),
 PRIMARY KEY(message_id, asset_id),
 UNIQUE(message_id, position),
 FOREIGN KEY(thread_id, message_id) REFERENCES product.messages(thread_id, message_id),
 FOREIGN KEY(thread_id, asset_id) REFERENCES product.assets(thread_id, asset_id)
);
-- Keep bytes and keys untouched; legacy namespaces remain valid storage references.
INSERT INTO product.assets(asset_id,thread_id,source,name,mime_type,byte_length,sha256,object_key,ready_at,created_at)
 SELECT material_id,thread_id,'upload',name,mime_type,byte_length,sha256,object_key,completed_at,created_at FROM product.materials;
INSERT INTO product.assets(asset_id,thread_id,source,name,mime_type,byte_length,sha256,object_key,ready_at,run_id,message_id,created_at)
 SELECT artifact_id,thread_id,'generated',name,mime_type,byte_length,sha256,object_key,created_at,run_id,message_id,created_at FROM product.artifacts;
INSERT INTO product.message_assets SELECT thread_id,message_id,material_id,position FROM product.message_materials;
INSERT INTO product.message_assets
 SELECT thread_id,message_id,artifact_id,(row_number() OVER(PARTITION BY message_id ORDER BY created_at,artifact_id)-1)::integer FROM product.artifacts;
-- Retained JSON is replay authority. Preserve absence of optional file fields.
-- An explicit empty legacy list is still a valid text input. jsonb_agg over
-- zero rows is SQL NULL, which must not erase a retained replay command.
UPDATE product.command_outbox SET command = CASE
 WHEN jsonb_array_length(command #> '{input,materials}') = 0 THEN command #- '{input,materials}'
 ELSE jsonb_set(command #- '{input,materials}', '{input,assets}',
 (SELECT jsonb_agg((f - 'materialID') || jsonb_build_object('assetID',f->'materialID') ORDER BY position)
 FROM jsonb_array_elements(command #> '{input,materials}') WITH ORDINALITY AS files(f,position))) END
 WHERE command #> '{input,materials}' IS NOT NULL;
UPDATE execution.command_inbox SET command = CASE
 WHEN jsonb_array_length(command #> '{input,materials}') = 0 THEN command #- '{input,materials}'
 ELSE jsonb_set(command #- '{input,materials}', '{input,assets}',
 (SELECT jsonb_agg((f - 'materialID') || jsonb_build_object('assetID',f->'materialID') ORDER BY position)
 FROM jsonb_array_elements(command #> '{input,materials}') WITH ORDINALITY AS files(f,position))) END
 WHERE command #> '{input,materials}' IS NOT NULL;
UPDATE product.execution_events SET payload = (payload - 'artifacts') || jsonb_build_object('assets',
 COALESCE((SELECT jsonb_agg((f - 'artifactID') || jsonb_build_object('assetID',f->'artifactID') ORDER BY position)
 FROM jsonb_array_elements(payload->'artifacts') WITH ORDINALITY AS files(f,position)), '[]'::jsonb))
 WHERE payload ? 'artifacts';
UPDATE execution.event_outbox SET event = (event - 'artifacts') || jsonb_build_object('assets',
 COALESCE((SELECT jsonb_agg((f - 'artifactID') || jsonb_build_object('assetID',f->'artifactID') ORDER BY position)
 FROM jsonb_array_elements(event->'artifacts') WITH ORDINALITY AS files(f,position)), '[]'::jsonb))
 WHERE event ? 'artifacts';
DROP TABLE product.message_materials;
DROP TABLE product.materials;
DROP TABLE product.artifacts;

-- migrate:down
-- A reversal would discard unified references to prior generated files.
DO $$ BEGIN RAISE EXCEPTION 'Asset consolidation is forward-only'; END $$;
