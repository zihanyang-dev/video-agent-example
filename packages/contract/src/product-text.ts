import { z } from 'zod'

// Unicode mode preserves surrogate pairs but rejects lone surrogates, which
// PostgreSQL JSONB cannot represent. Reject NUL rather than lossy replacement.
export const productTextSchema = z.string().regex(
  // oxlint-disable-next-line no-control-regex -- PostgreSQL rejects NUL; keep the runtime and JSON Schema boundary aligned.
  /^[^\u0000\ud800-\udfff]*$/u,
  'Text must be representable in PostgreSQL',
)
