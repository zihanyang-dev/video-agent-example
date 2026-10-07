import { expect, test } from 'bun:test'
import { collectRequestBody, readBody, requestBodyRejection } from './request-body'

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
  expect(await readBody(request, policy).catch((cause: unknown) => cause)).toMatchObject({
    name: 'QuotaExceededError',
  })
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

test('JSON transport failure is not reported as malformed input', async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error('Private transport detail'))
    },
  })
  const failure = await readBody(
    new Request('http://localhost', { method: 'POST', body }),
    policy,
  ).catch((cause: unknown) => cause)
  expect(failure).toMatchObject({ name: 'NetworkError' })
  expect(String(failure)).not.toContain('Private transport detail')
  expect(body.locked).toBe(false)
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
    await collectRequestBody(body, 3, new AbortController().signal).catch(() => null),
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

test('progressing JSON stops on shutdown and awaits underlying cancellation', async () => {
  const shutdown = new AbortController()
  const progressed = Promise.withResolvers<void>()
  const cancellation = Promise.withResolvers<void>()
  const finishCancellation = Promise.withResolvers<void>()
  const finishPull = Promise.withResolvers<void>()
  let chunks = 0
  let source: ReadableStreamDefaultController<Uint8Array> | undefined
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      source = controller
    },
    pull(controller) {
      chunks++
      controller.enqueue(new TextEncoder().encode(' '))
      if (chunks < 2) return
      progressed.resolve()
      return finishPull.promise
    },
    cancel() {
      cancellation.resolve()
      return finishCancellation.promise
    },
  })
  let settled = false
  const result = readBody(new Request('http://localhost', { method: 'POST', body }), {
    signal: shutdown.signal,
    timeoutMs: 1000,
  })
    .catch((cause: unknown) => cause)
    .finally(() => {
      settled = true
    })
  try {
    await progressed.promise
    shutdown.abort()
    expect(
      await Promise.race([cancellation.promise.then(() => true), Bun.sleep(150).then(() => false)]),
    ).toBe(true)
    expect(chunks).toBe(2)
    expect(settled).toBe(false)
    expect(body.locked).toBe(true)
  } finally {
    shutdown.abort()
    finishCancellation.resolve()
    finishPull.resolve()
    // A broken abort listener must not make this test's own cleanup depend on
    // cancellation having started. Closing the owned source releases read().
    try {
      source?.close()
    } catch {
      // A correctly cancelled source is already closed.
    }
    await result
  }
  expect(await result).toMatchObject({ name: 'AbortError' })
  expect(body.locked).toBe(false)
})

test('a stalled JSON body uses its deadline rather than malformed-input recovery', async () => {
  let source: ReadableStreamDefaultController<Uint8Array> | undefined
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      source = controller
    },
  })
  const result = readBody(new Request('http://localhost', { method: 'POST', body }), {
    signal: new AbortController().signal,
    timeoutMs: 10,
  }).catch((cause: unknown) => cause)
  try {
    expect(await Promise.race([result, Bun.sleep(150).then(() => null)])).toMatchObject({
      name: 'TimeoutError',
    })
    expect(body.locked).toBe(false)
  } finally {
    try {
      source?.close()
    } catch {
      // Correct cancellation has already closed this owned source.
    }
    await result
  }
})

test('process shutdown cancels an unfinished JSON reader', async () => {
  const shutdown = new AbortController()
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true
    },
  })
  const result = readBody(new Request('http://localhost', { method: 'POST', body }), {
    signal: shutdown.signal,
    timeoutMs: 1000,
  }).catch((cause: unknown) => cause)
  shutdown.abort()
  const finished = await Promise.race([result.then(() => true), Bun.sleep(150).then(() => false)])
  expect(finished).toBe(true)
  expect(cancelled).toBe(true)
  expect(body.locked).toBe(false)
})

test('native errored body keeps private details out of its HTTP rejection', async () => {
  const original = new Error('Private read detail')
  let cancelCalls = 0
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(original)
    },
    cancel() {
      cancelCalls++
    },
  })
  const failure = await collectRequestBody(body, 3, new AbortController().signal).catch(
    (cause: unknown) => cause,
  )
  expect(failure).toMatchObject({ name: 'NetworkError' })
  expect(body.locked).toBe(false)
  // An already errored native stream does not call underlying cancel().
  expect(cancelCalls).toBe(0)
  expect(String(failure)).not.toContain('Private read detail')
  const response = requestBodyRejection(failure)
  expect(response?.status).toBe(503)
  expect(await response?.text()).not.toContain('Private read detail')
})

test('quota rejection remains primary when cancellation also fails', async () => {
  const original = new Error('Private cancellation detail')
  const started = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  let cancelCalls = 0
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1]))
    },
    async cancel() {
      cancelCalls++
      started.resolve()
      await finish.promise
      throw original
    },
  })
  let settled = false
  const result = collectRequestBody(body, 0, new AbortController().signal)
    .catch((cause: unknown) => cause)
    .finally(() => {
      settled = true
    })
  try {
    await started.promise
    expect(settled).toBe(false)
    expect(body.locked).toBe(true)
  } finally {
    finish.resolve()
    await result
  }
  const failure = await result
  expect(cancelCalls).toBe(1)
  expect(body.locked).toBe(false)
  expect(failure).toMatchObject({ name: 'QuotaExceededError' })
  const response = requestBodyRejection(failure)
  expect(response?.status).toBe(413)
  expect(await response?.text()).not.toContain('Private cancellation detail')
})

for (const [name, status] of [
  ['TimeoutError', 408],
  ['AbortError', 503],
] as const) {
  test(`native ${name} stays public-safe when cancellation fails`, async () => {
    const stop = new DOMException('Private stop detail', name)
    const cleanup = new Error('Private cleanup detail')
    const abort = new AbortController()
    const started = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    let cancelCalls = 0
    let cancelReason: unknown
    const body = new ReadableStream<Uint8Array>({
      async cancel(reason) {
        cancelCalls++
        cancelReason = reason
        started.resolve()
        await finish.promise
        throw cleanup
      },
    })
    let settled = false
    const result = collectRequestBody(body, 3, abort.signal)
      .catch((cause: unknown) => cause)
      .finally(() => {
        settled = true
      })
    abort.abort(stop)
    try {
      await started.promise
      expect(settled).toBe(false)
      expect(body.locked).toBe(true)
    } finally {
      finish.resolve()
      await result
    }
    const failure = await result
    expect(cancelCalls).toBe(1)
    expect(cancelReason).toBe(stop)
    expect(body.locked).toBe(false)
    expect(failure).toMatchObject({ name })
    expect(String(failure)).not.toContain('Private stop detail')
    const response = requestBodyRejection(failure)
    expect(response?.status).toBe(status)
    expect(await response?.text()).not.toContain('Private')
  })
}
