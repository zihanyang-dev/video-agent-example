/**
 * Object storage, on an S3 bucket.
 *
 * The two shapes exist because there are two callers with different trust. The agent
 * process moves bytes, because it holds the bucket credentials. A script inside the sandbox
 * holds nothing, so it is handed a URL that expires -- and the agent never learns which URL
 * a script used, because the script announces the result rather than returning it
 * (architecture.md §8).
 */
import { S3Client } from 'bun'
import type { Files } from './files'

/**
 * Long enough for a render to finish uploading over a slow link, short enough that a URL
 * caught in a log is not a standing key. The sandbox is destroyed at the end of the turn,
 * so nothing inside it outlives this anyway.
 */
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
     * Every page, not the first thousand. A thread that rendered more files than one
     * response holds would otherwise come back to a sandbox missing the rest, and nothing
     * would say so.
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

    uploadUrl: async (key) => bucket.presign(key, { method: 'PUT', expiresIn: EXPIRES_SECONDS }),

    downloadUrl: async (key) => bucket.presign(key, { method: 'GET', expiresIn: EXPIRES_SECONDS }),
  }
}
