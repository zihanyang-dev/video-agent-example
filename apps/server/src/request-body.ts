export type BodyCollectionPolicy = Readonly<{
  signal: AbortSignal
  timeoutMs: number
}>

export async function collectRequestBody(
  body: ReadableStream<Uint8Array>,
  max: number,
  signal: AbortSignal,
) {
  const reader = body.getReader()
  let cancellation: Promise<void> | undefined
  const abort = () => {
    // Cancellation cleanup must not replace the primary HTTP failure.
    cancellation ??= reader.cancel(signal.reason).catch(() => {})
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    return await readChunks(reader, max, signal)
  } catch (cause) {
    if (signal.aborted) {
      throw signal.reason instanceof DOMException &&
        signal.reason.name === 'TimeoutError'
        ? new DOMException('Request body timed out', 'TimeoutError')
        : new DOMException('Request body collection stopped', 'AbortError')
    } else if (
      cause instanceof DOMException &&
      cause.name === 'QuotaExceededError'
    ) {
      throw new DOMException(
        'Request body exceeds byte limit',
        'QuotaExceededError',
      )
    }
    throw new DOMException('Request body transport failed', 'NetworkError')
  } finally {
    signal.removeEventListener('abort', abort)
    cancellation ??= reader.cancel().catch(() => {})
    await cancellation
    reader.releaseLock()
  }
}

async function readChunks(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  max: number,
  signal: AbortSignal,
) {
  const chunks: Uint8Array[] = []
  let length = 0
  signal.throwIfAborted()
  while (true) {
    const chunk = await reader.read()
    signal.throwIfAborted()
    if (chunk.done) break
    length += chunk.value.length
    if (length > max)
      throw new DOMException(
        'Request body exceeds byte limit',
        'QuotaExceededError',
      )
    chunks.push(chunk.value)
  }
  return Buffer.concat(chunks, length)
}

export async function readBody(
  request: Request,
  policy: BodyCollectionPolicy,
): Promise<unknown> {
  if (!request.body) return undefined
  const signal = AbortSignal.any([
    request.signal,
    policy.signal,
    AbortSignal.timeout(policy.timeoutMs),
  ])
  const bytes = await collectRequestBody(request.body, 65536, signal)
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    return undefined
  }
}

/** Collection failures require different recovery from malformed JSON. Native
 * exception names carry only the boundary category, never private stream text. */
export function requestBodyRejection(cause: unknown): Response | undefined {
  if (!(cause instanceof DOMException)) return undefined
  switch (cause.name) {
    case 'QuotaExceededError':
      return Response.json({ error: 'Request body too large' }, { status: 413 })
    case 'TimeoutError':
      return Response.json(
        { error: 'Request body timed out. Retry the same request.' },
        { status: 408 },
      )
    case 'AbortError':
      return Response.json(
        { error: 'Request body collection stopped. Retry after recovery.' },
        { status: 503 },
      )
    case 'NetworkError':
      return Response.json(
        { error: 'Request body transport failed. Retry the same request.' },
        { status: 503 },
      )
    default:
      return undefined
  }
}
