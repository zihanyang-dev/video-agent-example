import { uploadAsset } from '@vid/contract/client'
import { apiForUser } from '../http'
import type { ThreadScope } from '../conversations/queries'

export type PendingUpload = Readonly<{
  assetID: string
  name: string
  bytes: Blob
}>

async function uploadCache(scope: ThreadScope) {
  return await caches.open(
    `frame:uploads:${encodeURIComponent(scope.userID)}:${scope.threadID}`,
  )
}
function uploadKey(assetID: string) {
  return new URL(`/.frame-pending-upload/${assetID}`, window.location.origin)
    .href
}

export async function freezeUpload(
  scope: ThreadScope,
  file: File,
): Promise<PendingUpload> {
  const upload = {
    assetID: crypto.randomUUID(),
    name: file.name,
    bytes: file.slice(0, file.size, file.type),
  }
  const cache = await uploadCache(scope)
  await cache.put(
    uploadKey(upload.assetID),
    new Response(upload.bytes, {
      headers: {
        'Content-Type': file.type,
        'x-file-name': encodeURIComponent(file.name),
      },
    }),
  )
  return upload
}

export async function readUploads(
  scope: ThreadScope,
): Promise<PendingUpload[]> {
  const cache = await uploadCache(scope)
  const uploads: PendingUpload[] = []
  for (const key of await cache.keys()) {
    const saved = await cache.match(key)
    if (!saved) continue
    uploads.push({
      assetID: new URL(key.url).pathname.split('/').at(-1) ?? '',
      name: decodeURIComponent(saved.headers.get('x-file-name') ?? ''),
      bytes: await saved.blob(),
    })
  }
  return uploads
}

export async function sendUpload(scope: ThreadScope, upload: PendingUpload) {
  const { data: receipt } = await uploadAsset({
    client: apiForUser(scope.userID),
    path: { threadID: scope.threadID },
    body: upload.bytes,
    headers: {
      'x-asset-id': upload.assetID,
      'x-file-name': encodeURIComponent(upload.name),
      'Content-Type': upload.bytes.type,
    },
    throwOnError: true,
  })
  const cache = await uploadCache(scope)
  await cache.delete(uploadKey(upload.assetID))
  return receipt
}
