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
    cancellation ??= reader.cancel(signal.reason).catch(() => {})
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    return await readChunks(reader, max, signal)
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
    if (length > max) throw new Error('Upload too large')
    chunks.push(chunk.value)
  }
  return Buffer.concat(chunks, length)
}

export async function readBody(
  request: Request,
  policy: BodyCollectionPolicy,
): Promise<unknown> {
  try {
    if (!request.body) return undefined
    const signal = AbortSignal.any([
      request.signal,
      policy.signal,
      AbortSignal.timeout(policy.timeoutMs),
    ])
    const bytes = await collectRequestBody(request.body, 65536, signal)
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    return undefined
  }
}
