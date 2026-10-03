-- migrate:up
CREATE SCHEMA product;

CREATE TYPE product.message_role AS ENUM ('user', 'assistant');

CREATE TABLE product.threads (
  thread_id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE product.messages (
  message_id uuid PRIMARY KEY,
  thread_id uuid NOT NULL REFERENCES product.threads (thread_id),
  role product.message_role NOT NULL,
  text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX messages_thread_created_at_idx
  ON product.messages (thread_id, created_at);

CREATE TABLE product.command_outbox (
  command_id uuid PRIMARY KEY,
  thread_id uuid NOT NULL REFERENCES product.threads (thread_id),
  run_id uuid NOT NULL,
  message_id uuid UNIQUE REFERENCES product.messages (message_id),
  command jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);

-- migrate:down
DROP TABLE product.command_outbox;
DROP TABLE product.messages;
DROP TABLE product.threads;
DROP TYPE product.message_role;
DROP SCHEMA product;
