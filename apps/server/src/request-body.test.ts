import { expect, test } from 'bun:test'
import { collectRequestBody, readBody } from './request-body'

const policy = { signal: new AbortController().signal, timeoutMs: 1000 }

test('JSON bodies reject corrupt UTF-8 instead of replacing bytes', async () => {
  const request = new Request('http://localhost', {
    method: 'POST',
    body: new Uint8Array([123, 34, 120, 34, 58, 34, 255, 34, 125]),
  })
  expect(await readBody(request, policy)).toBeUndefined()
})

test('JSON body size comes from bytes, not Content-Length', async () => {
  const request = new Request('http://localhost', {
    method: 'POST',
    headers: { 'content-length': '2' },
    body: JSON.stringify('x'.repeat(65536)),
  })
  expect(await readBody(request, policy)).toBeUndefined()
  expect(
    await readBody(
      new Request('http://localhost', {
        method: 'POST',
        body: '{"accepted":true}',
      }),
      policy,
    ),
  ).toEqual({ accepted: true })
})

test('collection counts every chunk and releases an oversized body', async () => {
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2]))
      controller.enqueue(new Uint8Array([3, 4]))
    },
    cancel() {
      cancelled = true
    },
  })
  expect(
    await collectRequestBody(body, 3, new AbortController().signal).catch(
      () => null,
    ),
  ).toBeNull()
  expect(cancelled).toBe(true)
  expect(body.locked).toBe(false)
})

test('abort waits for cancellation to settle before releasing the reader', async () => {
  const abort = new AbortController()
  let settleCancellation: (() => void) | undefined
  let beginCancellation: (() => void) | undefined
  const cancellationStarted = new Promise<void>((resolve) => {
    beginCancellation = resolve
  })
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      beginCancellation?.()
      return new Promise<void>((resolve) => {
        settleCancellation = resolve
      })
    },
  })
  let settled = false
  const collected = collectRequestBody(body, 3, abort.signal)
    .catch(() => null)
    .finally(() => {
      settled = true
    })
  abort.abort()
  await cancellationStarted
  expect(settled).toBe(false)
  expect(body.locked).toBe(true)
  settleCancellation?.()
  expect(await collected).toBeNull()
  expect(body.locked).toBe(false)
})

test('continuously progressing JSON expires and awaits underlying cancellation', async () => {
  const shutdown = new AbortController()
  let finishCancel!: () => void
  let startedCancel!: () => void
  const cancellation = new Promise<void>((resolve) => {
    startedCancel = resolve
  })
  let chunks = 0
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      await Bun.sleep(5)
      chunks++
      controller.enqueue(new TextEncoder().encode(' '))
    },
    cancel() {
      startedCancel()
      return new Promise<void>((resolve) => {
        finishCancel = resolve
      })
    },
  })
  const client = new AbortController()
  const request = new Request('http://localhost', {
    method: 'POST',
    body,
    signal: client.signal,
  })
  let settled = false
  const result = readBody(request, {
    signal: shutdown.signal,
    timeoutMs: 30,
  }).finally(() => {
    settled = true
  })
  try {
    expect(
      await Promise.race([
        cancellation.then(() => true),
        Bun.sleep(150).then(() => false),
      ]),
    ).toBe(true)
    expect(chunks).toBeGreaterThan(1)
    expect(settled).toBe(false)
    expect(body.locked).toBe(true)
  } finally {
    shutdown.abort()
    client.abort()
    await cancellation
    finishCancel?.()
    await result
  }
  expect(settled).toBe(true)
  expect(body.locked).toBe(false)
})

test('process shutdown cancels an unfinished JSON reader', async () => {
  const shutdown = new AbortController()
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true
    },
  })
  const result = readBody(
    new Request('http://localhost', { method: 'POST', body }),
    { signal: shutdown.signal, timeoutMs: 1000 },
  )
  shutdown.abort()
  const finished = await Promise.race([
    result.then(() => true),
    Bun.sleep(150).then(() => false),
  ])
  expect(finished).toBe(true)
  expect(cancelled).toBe(true)
  expect(body.locked).toBe(false)
})
