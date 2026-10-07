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
  expect(sha256(bytes)).toBe('f742b965f156c10374bc23aea96e3a8aff8facd6fc079defeaa30219ad86f211')
  settled = false
  const failure = await boundedBytes(chunks(), 2).catch((cause: unknown) => cause)
  expect(failure).toBeInstanceOf(Error)
  expect(failure instanceof Error && failure.message).toBe('Object byte limit exceeded')
  expect(settled).toBeTrue()
})

test('native S3 PUT retains immutable facts and the client refuses retryable responses', async () => {
  const digest = 'f742b965f156c10374bc23aea96e3a8aff8facd6fc079defeaa30219ad86f211'
  const bytes = new Uint8Array([0, 255, 128])
  const requests: {
    method: string
    path: string
    headers: Headers
    bytes: Uint8Array
  }[] = []
  let refused = false
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const wire = new Uint8Array(await request.arrayBuffer())
      const chunked = request.headers.get('content-encoding') === 'aws-chunked'
      if (chunked) expect(wire.slice(0, 3)).toEqual(new Uint8Array([51, 13, 10]))
      const decoded = chunked ? wire.slice(3, 6) : wire
      requests.push({
        method: request.method,
        path: new URL(request.url).pathname,
        headers: request.headers,
        bytes: decoded,
      })
      return refused
        ? new Response(
            '<Error><Code>SlowDown</Code><Message>Owned retry refusal</Message></Error>',
            { status: 503, headers: { 'content-type': 'application/xml' } },
          )
        : new Response(null, { status: 200 })
    },
  })
  let objects: ReturnType<typeof connectObjects> | undefined
  const failures: unknown[] = []
  try {
    objects = connectObjects({
      endpoint: server.url.toString(),
      region: 'us-east-1',
      bucket: 'binary-test',
      accessKeyID: 'fixture',
      secretAccessKey: 'fixture-secret',
    })
    expect(
      await objects.put('owned-key', bytes, 'application/octet-stream', AbortSignal.timeout(10000)),
    ).toEqual({ byteLength: 3, sha256: digest })
    expect(requests).toHaveLength(1)
    const saved = requests[0]!
    expect(saved.method).toBe('PUT')
    expect(saved.path).toBe('/binary-test/owned-key')
    expect(saved.bytes).toEqual(bytes)
    expect(saved.headers.get('if-none-match')).toBe('*')
    expect(saved.headers.get('content-type')).toBe('application/octet-stream')
    expect(saved.headers.get('x-amz-meta-sha256')).toBe(digest)
    refused = true
    expect(
      await objects
        .put('owned-key', bytes, 'application/octet-stream', AbortSignal.timeout(10000))
        .catch((cause: unknown) => cause),
    ).toBeInstanceOf(Error)
    expect(requests).toHaveLength(2)
    // A Readable PUT body is itself non-retryable in the pinned SDK. GET has no
    // streaming request body, so retryable 503 also proves client maxAttempts.
    expect(
      await objects
        .read('owned-key', 3, AbortSignal.timeout(10000))
        .catch((cause: unknown) => cause),
    ).toBeInstanceOf(Error)
    expect(requests).toHaveLength(3)
    expect(requests[2]?.method).toBe('GET')
  } catch (cause) {
    failures.push(cause)
  }
  const cleanup = await Promise.allSettled([
    Promise.resolve().then(() => objects?.close()),
    Promise.resolve().then(() => server.stop(true)),
  ])
  for (const result of cleanup) if (result.status === 'rejected') failures.push(result.reason)
  if (failures.length > 1) throw new AggregateError(failures, 'Owned S3 fixture failed')
  if (failures.length === 1) throw failures[0]
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
      expect(await objects.read('owned-key', 4, AbortSignal.timeout(5000))).toEqual(bytes)
      const failure = await objects
        .read('owned-key', 3, AbortSignal.timeout(5000))
        .catch((cause: unknown) => cause)
      expect(failure).toBeInstanceOf(Error)
      expect(failure instanceof Error && failure.message).toBe('Object byte limit exceeded')
    }
  } finally {
    objects.close()
    await server.stop(true)
  }
})
