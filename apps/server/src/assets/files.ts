import { publicFileNameSchema, type UploadMimeType } from '@vid/contract/http'
import {
  ASSET_MAX_OUTPUT_FILES,
  assetReferenceSchema,
  type AssetReference,
} from '@vid/contract/execution'

/** Stored MIME authority comes from the actual bytes, never the browser's name alone.
 * These formats are staged inputs. Receiving audio/video does not imply model support. */
export function validateFile(name: string, mimeType: string, bytes: Uint8Array): boolean {
  if (!publicFileNameSchema.safeParse(name).success) return false
  if (!Object.hasOwn(fileSignatures, mimeType)) return false
  const verify = fileSignatures[mimeType]
  return verify === undefined ? false : verify(bytes)
}
// The actual byte verifiers also define the documented accepted media types.
const fileSignatures: Readonly<Record<string, (bytes: Uint8Array) => boolean>> = {
  'text/plain': (bytes) => validText(bytes, false),
  'application/json': (bytes) => validText(bytes, true),
  'image/png': (bytes) => prefix(bytes, [137, 80, 78, 71, 13, 10, 26, 10]),
  'image/jpeg': (bytes) =>
    prefix(bytes, [255, 216, 255]) &&
    bytes[bytes.length - 2] === 255 &&
    bytes[bytes.length - 1] === 217,
  'image/gif': (bytes) => ascii(bytes, 0, 'GIF87a') || ascii(bytes, 0, 'GIF89a'),
  'image/webp': (bytes) => ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP'),
  'audio/wav': (bytes) => ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WAVE'),
  'video/mp4': (bytes) => bytes.length >= 12 && ascii(bytes, 4, 'ftyp'),
  'application/pdf': (bytes) => ascii(bytes, 0, '%PDF-'),
} satisfies Record<UploadMimeType, (bytes: Uint8Array) => boolean>
function prefix(bytes: Uint8Array, values: number[]) {
  return values.every((value, index) => bytes[index] === value)
}
function ascii(bytes: Uint8Array, offset: number, value: string) {
  return value.split('').every((char, index) => bytes[offset + index] === char.charCodeAt(0))
}

type FileFacts = Readonly<{
  name: string
  mimeType: string
  byteLength: number
  sha256: string
}>
export function sameFile(left: FileFacts, right: FileFacts): boolean {
  return (
    left.name === right.name &&
    left.mimeType === right.mimeType &&
    left.byteLength === right.byteLength &&
    left.sha256 === right.sha256
  )
}

function validText(bytes: Uint8Array, json: boolean) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (text.includes('\0')) return false
    if (json) JSON.parse(text)
    return true
  } catch {
    return false
  }
}

export type AssetLimits = Readonly<{ maxBytes: number; maxFiles: number }>
/** These are trusted worker facts, not browser-upload fields. The exact run
 * namespace prevents a late or foreign generation from publishing its keys. */
export function validGeneratedAssets(
  query: Readonly<{ threadID: string; runID: string }>,
  assets: readonly AssetReference[],
  limits: AssetLimits,
) {
  if (assets.length > ASSET_MAX_OUTPUT_FILES) return false
  if (new Set(assets.map((file) => file.assetID)).size !== assets.length) return false
  const runKey = new RegExp(
    `^(artifacts|assets/generated)/${query.threadID}/${query.runID}/[1-9][0-9]*/([^/]+)$`,
  )
  const validFiles = assets.every((file) => {
    if (!assetReferenceSchema.safeParse(file).success) return false
    const key = runKey.exec(file.objectKey)
    if (!key || key[2] !== file.assetID) return false
    // Legacy GET-only keys retain the old SQL per-file limit. This is metadata
    // acceptance, not a relaxation of configured upload or download IO budgets.
    return file.byteLength <= (key[1] === 'artifacts' ? 16 * 1024 * 1024 : limits.maxBytes)
  })
  if (!validFiles) return false

  const legacyPrefix = `artifacts/${query.threadID}/${query.runID}/`
  let currentFiles = 0
  let currentBytes = 0
  for (const file of assets) {
    if (file.objectKey.startsWith(legacyPrefix)) continue
    currentFiles += 1
    currentBytes += file.byteLength
  }
  return currentFiles <= limits.maxFiles && currentBytes <= limits.maxBytes
}
