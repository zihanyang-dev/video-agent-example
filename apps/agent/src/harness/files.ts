import { sha256, type ObjectStore } from '@vid/object-storage'
import {
  assetReferenceSchema,
  type AssetReference,
} from '@vid/contract/execution'
import type {
  ExecutionLease,
  FileTools,
  SandboxSessionPort,
} from '../execute-run'

const exportMetadataSchema = assetReferenceSchema
  .unwrap()
  .pick({ name: true, mimeType: true })

type FileLimits = Readonly<{
  maxBytes: number
  maxFiles: number
  timeoutMs: number
}>

/** The server allocates incoming keys. Agent chooses all guest paths, while this
 * trusted capability alone allocates immutable output keys. Never deletes after
 * an unknown PUT/COMMIT acknowledgement; orphan reconciliation is operator work. */
export function assignFileTools(objects: ObjectStore, limits: FileLimits) {
  return (
    lease: ExecutionLease,
    sandbox: SandboxSessionPort,
    stopSpending: () => void,
  ): FileTools => {
    const assigned = lease.assets ?? []
    const prepared: AssetReference[] = []
    let count = 0
    let byteLength = 0
    let unknownOutcome = false
    function reserve(bytes: number) {
      count++
      byteLength += bytes
      if (count > limits.maxFiles || byteLength > limits.maxBytes)
        throw new Error('Asset IO budget exceeded')
    }
    function bounded(signal: AbortSignal) {
      return AbortSignal.any([signal, AbortSignal.timeout(limits.timeoutMs)])
    }
    return {
      assigned,
      prepared,
      hasUnknownOutcome: () => unknownOutcome,
      async importFile({ assetID, path, signal }) {
        const asset = assigned.find(
          (candidate) => candidate.assetID === assetID,
        )
        if (asset === undefined)
          throw new Error('Asset was not assigned to this run')
        reserve(asset.byteLength)
        const bytes = await objects.read(
          asset.objectKey,
          asset.byteLength,
          bounded(signal),
        )
        if (
          bytes.byteLength !== asset.byteLength ||
          sha256(bytes) !== asset.sha256
        )
          throw new Error('Assigned asset digest mismatch')
        try {
          await sandbox.files.writeBytes(path, bytes, bounded(signal))
        } catch (error) {
          unknownOutcome = true
          stopSpending()
          throw error
        }
        return { bytes, mimeType: asset.mimeType }
      },
      async exportFile({ path, name, mimeType, signal }) {
        // Validate model-produced public metadata before spending on an upload.
        const assetID = crypto.randomUUID()
        const objectKey = `assets/generated/${lease.threadID}/${lease.runID}/${lease.fence}/${assetID}`
        const metadata = exportMetadataSchema.parse({ name, mimeType })
        const bytes = await sandbox.files
          .readBytes(path, bounded(signal), limits.maxBytes - byteLength)
          .catch((error: unknown) => {
            unknownOutcome = true
            stopSpending()
            throw error
          })
        reserve(bytes.byteLength)
        let digest
        try {
          digest = await objects.put(
            objectKey,
            bytes,
            mimeType,
            bounded(signal),
          )
        } catch (error) {
          unknownOutcome = true
          stopSpending()
          // Pi may turn a tool error into text; abort spending rather than letting
          // it infer or export again after an uncertain external operation.
          throw error
        }
        const reference = { assetID, objectKey, ...metadata, ...digest }
        prepared.push(reference)
        return reference
      },
    }
  }
}
