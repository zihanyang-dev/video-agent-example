import { sha256, type ObjectStore } from '@vid/object-storage'
import { assetReferenceSchema, type AssetReference } from '@vid/contract/execution'
import {
  CapabilityRejectedError,
  type FileAssignment,
  type FileTools,
  type SandboxFiles,
} from '../contract.ts'

const exportMetadataSchema = assetReferenceSchema.unwrap().pick({ name: true, mimeType: true })

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
    assignment: FileAssignment,
    sandbox: SandboxFiles,
    stopSpending: () => void,
    beforePut: () => Promise<void | (() => Promise<void>)>,
  ): FileTools => {
    const assigned = assignment.assets ?? []
    const prepared: AssetReference[] = []
    let count = 0
    let byteLength = 0
    // Failed actions consume their reservation; no retries reclaim remote IO.
    function reserveFile() {
      if (count >= limits.maxFiles || byteLength >= limits.maxBytes)
        throw new Error('Asset IO budget exceeded')
      count++
    }
    function reserveBytes(bytes: number) {
      if (bytes > limits.maxBytes - byteLength) throw new Error('Asset IO budget exceeded')
      byteLength += bytes
    }
    function bounded(signal: AbortSignal) {
      return AbortSignal.any([signal, AbortSignal.timeout(limits.timeoutMs)])
    }
    return {
      assigned,
      prepared,
      async importFile({ assetID, path, signal }) {
        const asset = assigned.find((candidate) => candidate.assetID === assetID)
        if (asset === undefined) throw new Error('Asset was not assigned to this run')
        reserveFile()
        reserveBytes(asset.byteLength)
        const deadline = bounded(signal)
        deadline.throwIfAborted()
        const bytes = await objects.read(asset.objectKey, asset.byteLength, deadline)
        if (bytes.byteLength !== asset.byteLength || sha256(bytes) !== asset.sha256)
          throw new Error('Assigned asset digest mismatch')
        deadline.throwIfAborted()
        try {
          await sandbox.writeBytes(path, bytes, deadline)
        } catch (error) {
          if (error instanceof CapabilityRejectedError) throw error
          stopSpending()
          throw error
        }
        return { bytes, mimeType: asset.mimeType }
      },

      async exportFile({ path, name, mimeType, signal }) {
        // Validate model-produced public metadata before spending on an upload.
        const assetID = crypto.randomUUID()
        const objectKey = `assets/generated/${assignment.threadID}/${assignment.runID}/${assignment.fence}/${assetID}`
        const metadata = exportMetadataSchema.parse({ name, mimeType })
        reserveFile()
        const deadline = bounded(signal)
        deadline.throwIfAborted()
        const bytes = await sandbox.readBytes(path, deadline, limits.maxBytes - byteLength)
        reserveBytes(bytes.byteLength)
        deadline.throwIfAborted()
        // Current lease/cancel/budget admission belongs immediately before PUT,
        // after readonly guest IO and validation—not to a prior read callback.
        const releaseUnissued = await beforePut()
        try {
          deadline.throwIfAborted()
        } catch (error) {
          // This receipt belongs only to this PUT. Once objects.put is invoked,
          // even an SDK AbortError is an unknown outcome, never a refund proof.
          try {
            await releaseUnissued?.()
          } catch (correctionError) {
            throw new AggregateError([error, correctionError], 'Unissued PUT correction failed')
          }
          throw error
        }
        let digest
        try {
          digest = await objects.put(objectKey, bytes, mimeType, deadline)
        } catch (error) {
          stopSpending()
          // A harness may turn a tool error into text; abort spending rather than letting
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
