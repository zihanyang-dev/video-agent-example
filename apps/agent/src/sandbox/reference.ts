import { z } from 'zod'

const nativeSandboxReferenceSchema = z
  .strictObject({ provider: z.string().min(1), id: z.string().min(1) })
  .readonly()

export type NativeSandboxReference = z.infer<
  typeof nativeSandboxReferenceSchema
>

/** SQL JSON is untrusted; the provider owns the opaque identifier's meaning. */
export function sandboxReferenceFromJSON(reference: unknown) {
  if (reference === null) return undefined
  return nativeSandboxReferenceSchema.parse(reference)
}
