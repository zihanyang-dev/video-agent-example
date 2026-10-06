import { collectRequestBody, requestBodyRejection } from '../request-body'
import { publicUUIDSchema, type AssetResponse } from '@vid/contract/http'
import { sha256 } from '@vid/object-storage'
import type { Kysely } from 'kysely'
import type { DB } from '@vid/database/types'
import type { OwnedThread } from '../conversation/submission'
import { ownedAsset } from '../db/assets'
import { validateFile } from './files'
import { publishUpload, type FileHTTP } from './uploads'

const notFound = () => Response.json({ error: 'Not found' }, { status: 404 })

/** One raw binary per request. No multipart parser or caller storage authority.
 * Collection checks every chunk and cancels stalled bodies before releasing the
 * process request slot. Content-Length is only a hint, never the size authority. */
export async function uploadAsset(
  db: Kysely<DB>,
  query: OwnedThread,
  request: Request,
  io: FileHTTP,
) {
  const metadata = uploadMetadata(request)
  if (metadata === null || !request.body)
    return Response.json({ error: 'Invalid upload metadata' }, { status: 400 })
  const signal = AbortSignal.any([
    io.signal,
    request.signal,
    AbortSignal.timeout(io.timeoutMs),
  ])
  let bytes: Uint8Array
  try {
    bytes = await collectRequestBody(request.body, io.maxAssetBytes, signal)
  } catch (cause) {
    const rejection = requestBodyRejection(cause)
    if (rejection) return rejection
    throw cause
  }
  if (!validateFile(metadata.name, metadata.mimeType, bytes))
    return Response.json({ error: 'Invalid file' }, { status: 415 })
  const completion = await publishUpload(
    db,
    query,
    { ...metadata, bytes },
    { ...io, signal },
  )
  if (completion === null)
    return Response.json(
      { error: 'Upload not confirmed. Retry the same asset ID and file.' },
      { status: 503 },
    )
  return Response.json({ asset: completion.asset } satisfies AssetResponse, {
    status: completion.created ? 201 : 200,
  })
}

/** Bounded buffering trades memory for simple, fully-owned shutdown. Downloads
 * are attachments, never executable HTML; no long-lived bearer URL escapes. */
export async function downloadAsset(
  db: Kysely<DB>,
  query: Readonly<{
    ownerID: string
    assetID: string
  }>,
  request: Request,
  io: FileHTTP,
) {
  const row = await ownedAsset(db, query)
  if (!row) return notFound()
  const max = io.maxAssetBytes
  if (row.byte_length > max)
    return Response.json(
      { error: 'File exceeds download limit' },
      { status: 413 },
    )
  const signal = AbortSignal.any([
    io.signal,
    request.signal,
    AbortSignal.timeout(io.timeoutMs),
  ])
  try {
    const bytes = await io.objects.read(row.object_key, max, signal)
    if (
      bytes.length !== row.byte_length ||
      sha256(bytes) !== row.sha256 ||
      // Upload signatures do not restrict trusted exports (archives, binaries,
      // or other media). All downloads remain verified private attachments.
      (row.source === 'upload' && !validateFile(row.name, row.mime_type, bytes))
    )
      return Response.json(
        { error: 'File verification failed' },
        { status: 503 },
      )
    return new Response(Buffer.from(bytes), {
      headers: {
        'content-type': row.mime_type,
        'content-length': String(bytes.length),
        'content-disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(row.name).replace(/'/g, '%27')}`,
        'x-content-type-options': 'nosniff',
        'cache-control': 'private, no-store',
        'content-security-policy': "default-src 'none'; sandbox",
      },
    })
  } catch {
    return Response.json(
      { error: 'File unavailable. Try again.' },
      { status: 503 },
    )
  }
}

function uploadMetadata(request: Request) {
  const id = publicUUIDSchema.safeParse(request.headers.get('x-asset-id'))
  if (!id.success) return null
  try {
    return {
      assetID: id.data,
      name: decodeURIComponent(request.headers.get('x-file-name') ?? ''),
      mimeType: request.headers.get('content-type') ?? '',
    }
  } catch {
    return null
  }
}
