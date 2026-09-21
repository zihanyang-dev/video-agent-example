/**
 * Direct I/O requires bucket credentials. A signed download delegates temporary read access
 * to one key without sharing those credentials or allowing the recipient to overwrite it.
 */
import { S3Client } from 'bun'
import type { Files } from './files'

// Objects may persist indefinitely; shared links must not grant standing access.
const EXPIRES_SECONDS = 60 * 60

export type S3Settings = {
  bucket: string
  endpoint: string
  accessKeyId: string
  secretAccessKey: string
  region?: string | undefined
}

export const createS3Files = (settings: S3Settings): Files => {
  const bucket = new S3Client({
    bucket: settings.bucket,
    endpoint: settings.endpoint,
    accessKeyId: settings.accessKeyId,
    secretAccessKey: settings.secretAccessKey,
    ...(settings.region === undefined ? {} : { region: settings.region }),
  })

  return {
    /**
     * S3 limits each listing response. Returning just the first page would silently omit
     * existing objects, so callers receive the complete prefix regardless of page size.
     */
    list: async (prefix) => {
      const keys: string[] = []
      let continuationToken: string | undefined

      do {
        const page = await bucket.list({
          prefix,
          ...(continuationToken === undefined ? {} : { continuationToken }),
        })
        for (const entry of page.contents ?? []) keys.push(entry.key)
        continuationToken = page.nextContinuationToken
      } while (continuationToken !== undefined)

      return keys
    },

    get: async (key) => new Uint8Array(await bucket.file(key).arrayBuffer()),

    put: async (key, bytes) => {
      await bucket.write(key, bytes)
    },

    downloadUrl: async (key) => bucket.presign(key, { method: 'GET', expiresIn: EXPIRES_SECONDS }),
  }
}
