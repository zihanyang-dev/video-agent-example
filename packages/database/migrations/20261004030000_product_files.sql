-- migrate:up
ALTER TABLE product.messages ADD CONSTRAINT messages_thread_identity UNIQUE(thread_id, message_id);
CREATE TABLE product.materials (
 material_id uuid PRIMARY KEY,
 thread_id uuid NOT NULL REFERENCES product.threads(thread_id),
 name text NOT NULL,
 mime_type text NOT NULL,
 byte_length integer NOT NULL CHECK (byte_length > 0 AND byte_length <= 16777216),
 sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
 object_key text NOT NULL UNIQUE,
 completed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(thread_id, material_id),
 CHECK (object_key = 'materials/' || thread_id::text || '/' || material_id::text)
);
CREATE TABLE product.message_materials (
 thread_id uuid NOT NULL,
 message_id uuid NOT NULL,
 material_id uuid NOT NULL,
 position integer NOT NULL CHECK(position >= 0 AND position < 16),
 PRIMARY KEY(message_id, material_id),
 UNIQUE(message_id, position),
 FOREIGN KEY(thread_id, message_id) REFERENCES product.messages(thread_id, message_id),
 FOREIGN KEY(thread_id, material_id) REFERENCES product.materials(thread_id, material_id)
);
CREATE TABLE product.artifacts (
 artifact_id uuid PRIMARY KEY,
 thread_id uuid NOT NULL REFERENCES product.threads(thread_id),
 run_id uuid NOT NULL,
 message_id uuid NOT NULL,
 name text NOT NULL,
 mime_type text NOT NULL,
 byte_length integer NOT NULL CHECK(byte_length >= 0 AND byte_length <= 16777216),
 sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 object_key text NOT NULL UNIQUE,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(thread_id, message_id) REFERENCES product.messages(thread_id, message_id),
 CHECK(object_key ~ ('^artifacts/' || thread_id::text || '/' || run_id::text || '/[1-9][0-9]*/' || artifact_id::text || '$'))
);
-- migrate:down
DROP TABLE product.artifacts;
DROP TABLE product.message_materials;
DROP TABLE product.materials;
ALTER TABLE product.messages DROP CONSTRAINT messages_thread_identity;
