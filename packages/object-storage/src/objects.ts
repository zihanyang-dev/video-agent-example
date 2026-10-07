import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'

export type ObjectConnection = Readonly<{
  endpoint: string
  region: string
  bucket: string
  accessKeyID: string
  secretAccessKey: string
}>

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Reject each chunk before buffering; the SDK's byte transform is unbounded. */
export async function boundedBytes(
  chunks: AsyncIterable<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array> {
  const collected: Uint8Array[] = []
  let length = 0
  for await (const chunk of chunks) {
    length += chunk.byteLength
    if (length > maxBytes) throw new Error('Object byte limit exceeded')
    collected.push(chunk)
  }
  return Buffer.concat(collected, length)
}

/** This resource owns one client's sockets and bounded binary I/O. Credentials
 * are explicit: no discovery of host files or a metadata credential service. */
export function connectObjects(connection: ObjectConnection) {
  const s3 = new S3Client({
    endpoint: connection.endpoint,
    region: connection.region,
    credentials: {
      accessKeyId: connection.accessKeyID,
      secretAccessKey: connection.secretAccessKey,
    },
    forcePathStyle: true,
    maxAttempts: 1,
  })
  const bucket = connection.bucket

  return {
    async read(objectKey: string, maxBytes: number, signal: AbortSignal) {
      const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: objectKey }), {
        abortSignal: signal,
      })
      const body = response.Body
      if (!(body instanceof Readable)) throw new Error('Missing streaming object body')

      try {
        if (response.ContentLength !== undefined && response.ContentLength > maxBytes)
          throw new Error('Object byte limit exceeded')
        return await boundedBytes(body, maxBytes)
      } finally {
        body.destroy()
      }
    },

    async put(objectKey: string, bytes: Uint8Array, mimeType: string, signal: AbortSignal) {
      const digest = { byteLength: bytes.byteLength, sha256: sha256(bytes) }
      // Exact retries must not overwrite an assigned asset's bytes.
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: objectKey,
          Body: Readable.from([bytes]),
          ContentLength: bytes.byteLength,
          ContentType: mimeType,
          Metadata: { sha256: digest.sha256 },
          IfNoneMatch: '*',
        }),
        { abortSignal: signal },
      )
      return digest
    },

    close() {
      s3.destroy()
    },
  }
}

export type ObjectStore = ReturnType<typeof connectObjects>
