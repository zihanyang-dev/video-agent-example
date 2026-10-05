import { expect, test } from 'bun:test'
import { boundedBytes, connectObjects, sha256 } from './objects'

test('binary streams enforce limits before collection and always settle iteration', async () => {
  let settled = false
  async function* chunks() {
    try {
      yield new Uint8Array([0, 255])
      yield new Uint8Array([128])
    } finally {
      settled = true
    }
  }
  const bytes = new Uint8Array([0, 255, 128])
  expect(await boundedBytes(chunks(), 3)).toEqual(bytes)
  expect(sha256(bytes)).toBe(
    'f742b965f156c10374bc23aea96e3a8aff8facd6fc079defeaa30219ad86f211',
  )
  settled = false
  const failure = await boundedBytes(chunks(), 2).catch(
    (cause: unknown) => cause,
  )
  expect(failure).toBeInstanceOf(Error)
  expect(failure instanceof Error && failure.message).toBe(
    'Object byte limit exceeded',
  )
  expect(settled).toBeTrue()
})

test('native S3 GET bounds both declared and chunked HTTP bodies', async () => {
  const bytes = new Uint8Array([0, 255, 128, 10])
  let chunked = false
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(
        chunked
          ? new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(bytes.slice(0, 2))
                controller.enqueue(bytes.slice(2))
                controller.close()
              },
            })
          : bytes,
      ),
  })
  const objects = connectObjects({
    endpoint: server.url.toString(),
    region: 'us-east-1',
    bucket: 'binary-test',
    accessKeyID: 'fixture',
    secretAccessKey: 'fixture-secret',
  })
  try {
    for (chunked of [false, true]) {
      expect(
        await objects.read('owned-key', 4, AbortSignal.timeout(5000)),
      ).toEqual(bytes)
      const failure = await objects
        .read('owned-key', 3, AbortSignal.timeout(5000))
        .catch((cause: unknown) => cause)
      expect(failure).toBeInstanceOf(Error)
      expect(failure instanceof Error && failure.message).toBe(
        'Object byte limit exceeded',
      )
    }
  } finally {
    objects.close()
    await server.stop(true)
  }
})
