/**
 * Direct byte access and signed reads use a real S3-compatible service. A successful SDK
 * write alone cannot show that a URL works for a caller without bucket credentials.
 *
 * Needs `docker compose -f deploy/docker/compose.yaml up -d objects` and
 * `docker compose -f deploy/docker/compose.yaml run --rm objects-ready`.
 */
import { describe, expect, test } from 'bun:test'
import { createS3Files } from './s3-files'

const settings = {
  bucket: process.env['OBJECTS_BUCKET'] ?? 'vid',
  endpoint: process.env['OBJECTS_ENDPOINT'] ?? 'http://localhost:9000',
  accessKeyId: process.env['OBJECTS_ACCESS_KEY'] ?? 'vid',
  secretAccessKey: process.env['OBJECTS_SECRET_KEY'] ?? 'vid-secret',
  region: 'us-east-1',
}
const files = createS3Files(settings)

const workspace = (): string => `threads/${crypto.randomUUID()}/`

describe('moving bytes', () => {
  test('a rendered clip survives exactly', async () => {
    const prefix = workspace()
    const clip = new Uint8Array(Array.from({ length: 4_096 }, (_unused, n) => n % 256))

    await files.put(`${prefix}out.mp4`, clip)

    expect(await files.get(`${prefix}out.mp4`)).toEqual(clip)
  })

  test('a listing covers one thread and no other', async () => {
    const mine = workspace()
    const theirs = workspace()
    await files.put(`${mine}a.mp4`, new Uint8Array([1]))
    await files.put(`${mine}notes.txt`, new Uint8Array([2]))
    await files.put(`${theirs}a.mp4`, new Uint8Array([3]))

    expect(await files.list(mine)).toHaveLength(2)
  })

  /** A response holds a thousand keys. A thread that rendered more would silently lose the rest. */
  test('a listing pages past the first thousand', async () => {
    const prefix = workspace()
    await Promise.all(
      Array.from({ length: 1_200 }, (_unused, n) =>
        files.put(`${prefix}${String(n).padStart(4, '0')}.txt`, new Uint8Array([n % 256])),
      ),
    )

    expect(await files.list(prefix)).toHaveLength(1_200)
  }, 60_000)
})

describe('a url handed to a browser', () => {
  test('lets it download without ever holding a credential', async () => {
    const prefix = workspace()
    await files.put(`${prefix}out.mp4`, new Uint8Array([1, 2, 3]))

    const response = await fetch(await files.downloadUrl(`${prefix}out.mp4`))

    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
  })
})

test('nothing in the bucket is readable without a url we minted', async () => {
  const prefix = workspace()
  await files.put(`${prefix}out.mp4`, new Uint8Array([1]))

  const naked = await fetch(`${settings.endpoint}/${settings.bucket}/${prefix}out.mp4`)

  expect(naked.ok).toBe(false)
})
