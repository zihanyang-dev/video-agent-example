import type { AssetReference } from '@vid/contract/execution'
import { sha256, type ObjectStore } from '@vid/object-storage'
import type { Kysely } from 'kysely'
import type { DB } from '@vid/database/types'
import type { OwnedThread } from '../conversation/submission'
import { reserveAsset, completeAsset } from '../db/assets'

export type FileHTTP = Readonly<{
  objects: ObjectStore
  maxAssetBytes: number
  timeoutMs: number
  signal: AbortSignal
}>

/** Publish verified upload bytes under server-derived immutable storage facts.
 * Reservation and completion each check fresh ownership under the thread lock;
 * an unknown storage receipt leaves the reservation pending for an exact retry. */
export async function publishUpload(
  db: Kysely<DB>,
  query: OwnedThread,
  upload: Readonly<{
    assetID: string
    name: string
    mimeType: string
    bytes: Uint8Array
  }>,
  io: FileHTTP,
) {
  const asset = {
    assetID: upload.assetID,
    name: upload.name,
    mimeType: upload.mimeType,
    byteLength: upload.bytes.length,
    sha256: sha256(upload.bytes),
    objectKey: `assets/uploads/${query.threadID}/${upload.assetID}`,
  }
  const reservation = await reserveAsset(db, query, asset)
  const objectKey = await storeUpload(
    io,
    { ...asset, bytes: upload.bytes },
    reservation,
  )
  if (objectKey === null) return null
  return await completeAsset(db, query, upload.assetID, objectKey)
}

/** Reconcile storage before publishing SQL visibility, without legacy writes. */
async function storeUpload(
  io: FileHTTP,
  asset: AssetReference & Readonly<{ bytes: Uint8Array }>,
  reservation: Readonly<{ object_key: string; ready_at: Date | null }>,
) {
  // Legacy storage is read-only. First reconcile an uncertain historical PUT;
  // otherwise stage identical bytes at the deterministic writable location.
  // A failed GET is not proof of absence: never delete or overwrite old bytes.
  if (reservation.ready_at !== null) {
    const confirmed = await confirmStored(io, {
      ...asset,
      objectKey: reservation.object_key,
    })
    return confirmed ? reservation.object_key : null
  }

  if (reservation.object_key !== asset.objectKey) {
    const confirmed = await confirmStored(io, {
      ...asset,
      objectKey: reservation.object_key,
    })
    if (confirmed) return reservation.object_key
  }

  try {
    await io.objects.put(
      asset.objectKey,
      asset.bytes,
      asset.mimeType,
      io.signal,
    )
  } catch {
    // PUT may have committed despite a lost receipt (or an exact concurrent
    // retry won). Read the assigned key below; never blindly delete it.
  }
  const confirmed = await confirmStored(io, asset)
  return confirmed ? asset.objectKey : null
}
async function confirmStored(
  io: FileHTTP,
  asset: Readonly<{ objectKey: string; byteLength: number; sha256: string }>,
) {
  try {
    const stored = await io.objects.read(
      asset.objectKey,
      io.maxAssetBytes,
      io.signal,
    )
    return stored.length === asset.byteLength && sha256(stored) === asset.sha256
  } catch {
    return false
  }
}
