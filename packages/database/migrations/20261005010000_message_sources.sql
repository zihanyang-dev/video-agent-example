-- migrate:up
ALTER TABLE product.messages
  ADD COLUMN sources jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(sources) = 'array' AND jsonb_array_length(sources) <= 15);

-- migrate:down
ALTER TABLE product.messages DROP COLUMN sources;
