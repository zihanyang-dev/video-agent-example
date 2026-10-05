import type { DB } from '@vid/database/types'
import type { AssetReference } from '@vid/contract/execution'
import type { PublicAsset } from '@vid/contract/http'
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely'
import type { ProductAssets } from '@vid/database/types'
import { lockThread, threadConflict, threadUnavailable } from './thread-access'
import type { OwnedThread } from '../conversation/submission'
import { sameFile } from '../assets/files'

type AssetRow = Selectable<ProductAssets>
export function publicAsset(row: AssetRow): PublicAsset {
  return {
    assetID: row.asset_id,
    source: row.source === 'upload' ? 'upload' : 'generated',
    ...(row.message_id === null ? {} : { messageID: row.message_id }),
    ...(row.run_id === null ? {} : { runID: row.run_id }),
    name: row.name,
    mimeType: row.mime_type,
    byteLength: row.byte_length,
    createdAt: row.created_at.toISOString(),
  }
}
export function allocatedAsset(row: AssetRow): AssetReference {
  return {
    assetID: row.asset_id,
    name: row.name,
    mimeType: row.mime_type,
    byteLength: row.byte_length,
    sha256: row.sha256,
    objectKey: row.object_key,
  }
}

/** Reservation is immutable. An unknown PUT result remains pending, so a retry
 * can confirm the exact object without deleting another request's accepted bytes.
 * Thread locks serialize both reservation and final visibility with archive. */
export async function reserveAsset(
  db: Kysely<DB>,
  query: OwnedThread,
  asset: AssetReference,
) {
  return await db.transaction().execute(async (tx) => {
    await lockThread(tx, query, 'write')
    await tx
      .insertInto('product.assets')
      .values({
        asset_id: asset.assetID,
        source: 'upload',
        thread_id: query.threadID,
        name: asset.name,
        mime_type: asset.mimeType,
        byte_length: asset.byteLength,
        sha256: asset.sha256,
        object_key: asset.objectKey,
      })
      .onConflict((c) => c.doNothing())
      .execute()
    const row = await tx
      .selectFrom('product.assets')
      .selectAll()
      .where('asset_id', '=', asset.assetID)
      .executeTakeFirst()
    if (!row || row.thread_id !== query.threadID) throw threadUnavailable
    if (
      row.source !== 'upload' ||
      !sameFile(asset, {
        name: row.name,
        mimeType: row.mime_type,
        byteLength: row.byte_length,
        sha256: row.sha256,
      })
    )
      throw threadConflict
    return row
  })
}
export async function completeAsset(
  db: Kysely<DB>,
  query: OwnedThread,
  assetID: string,
  confirmedObjectKey?: string,
) {
  return await db.transaction().execute(async (tx) => {
    await lockThread(tx, query, 'write')
    const reserved = await tx
      .selectFrom('product.assets')
      .selectAll()
      .where('asset_id', '=', assetID)
      .where('thread_id', '=', query.threadID)
      .where('source', '=', 'upload')
      .executeTakeFirst()
    if (!reserved) throw threadUnavailable
    // First confirmed publication wins. A concurrent legacy confirmation or
    // rehome must never change the location of an already-visible asset.
    if (reserved.ready_at !== null)
      return { asset: publicAsset(reserved), created: false }
    const row = await tx
      .updateTable('product.assets')
      .set({
        ready_at: sql<Date>`clock_timestamp()`,
        object_key: confirmedObjectKey ?? reserved.object_key,
      })
      .where('asset_id', '=', assetID)
      .where('thread_id', '=', query.threadID)
      .returningAll()
      .executeTakeFirstOrThrow()
    return { asset: publicAsset(row), created: reserved.ready_at === null }
  })
}
export async function ownedAsset(
  db: Kysely<DB>,
  query: Readonly<{ ownerID: string; assetID: string }>,
) {
  return await db
    .selectFrom('product.assets as m')
    .innerJoin('product.threads as t', 't.thread_id', 'm.thread_id')
    .selectAll('m')
    .where('t.owner_id', '=', query.ownerID)
    .where('m.asset_id', '=', query.assetID)
    .where('m.ready_at', 'is not', null)
    .executeTakeFirst()
}
export async function allocatedAssets(
  tx: Transaction<DB>,
  threadID: string,
  ids: readonly string[],
) {
  if (!ids.length) return []
  const rows = await tx
    .selectFrom('product.assets')
    .selectAll()
    .where('thread_id', '=', threadID)
    .where('asset_id', 'in', ids)
    .where('ready_at', 'is not', null)
    .execute()
  const byID = new Map(rows.map((row) => [row.asset_id, row]))
  return ids.map((id) => {
    const row = byID.get(id.toLowerCase())
    if (!row) throw threadUnavailable
    return allocatedAsset(row)
  })
}
export async function messageAssets(tx: Transaction<DB>, messageID: string) {
  return await tx
    .selectFrom('product.message_assets as link')
    .innerJoin('product.assets as m', 'm.asset_id', 'link.asset_id')
    .selectAll('m')
    .where('link.message_id', '=', messageID)
    .orderBy('link.position')
    .execute()
}

export async function listAssets(db: Kysely<DB>, query: OwnedThread) {
  return await db.transaction().execute(async (tx) => {
    await lockThread(tx, query, 'read')
    const rows = await tx
      .selectFrom('product.assets')
      .selectAll()
      .where('thread_id', '=', query.threadID)
      .where('ready_at', 'is not', null)
      .orderBy('created_at')
      .orderBy('asset_id')
      .execute()
    return rows.map(publicAsset)
  })
}
