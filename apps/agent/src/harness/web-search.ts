import { z } from 'zod'
import {
  normalizeWebSource,
  WEB_SOURCES_PER_SEARCH,
  type WebSource,
} from '@vid/contract/web-source'
import type { WebSearchAuthMode } from '@vid/config'

export type WebSearchConfig = Readonly<{
  authMode: WebSearchAuthMode
  apiKey?: string
  /** Private trusted test seam: never sourced from env, model arguments or URLs. */
  transport?: (url: string, init: RequestInit) => Promise<Response>
}>

const endpoint = 'https://api.tavily.com/search'
const unavailable = 'Web search unavailable.'
const encoder = new TextEncoder()
const searchLimits = {
  requestsPerTurn: 3,
  providerBodyBytes: 262144,
  toolOutputBytes: 16384,
  requestTimeoutMs: 10000,
} as const
const entities: Readonly<Record<string, string>> = {
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&amp;': '&',
  '&nbsp;': ' ',
}

function plainText(value: string, limit: number) {
  const decoded = value
    .replace(/&(?:lt|gt|quot|apos|amp|nbsp);/gi, (entity) => entities[entity.toLowerCase()] ?? '')
    .replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (_entity, code: string) => {
      const point = code.toLowerCase().startsWith('x')
        ? Number.parseInt(code.slice(1), 16)
        : Number(code)
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : ''
    })
  const text = decoded
    .replace(/<(script|style|think|thinking)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/[<>]/g, '')
    .replace(
      // Control and invisible formatting characters must not enter model evidence.
      // oxlint-disable-next-line no-control-regex
      /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g,
      ' ',
    )
    .replace(/\s+/g, ' ')
    .trim()
  return Array.from(text).slice(0, limit).join('')
}

const providerPayload = z.object({
  results: z.array(z.object({ title: z.string(), url: z.string(), content: z.string() })),
})
const searchQuery = z
  .string()
  .trim()
  .min(1)
  .refine((value) => Array.from(value).length <= 400)
  .refine((value) => encoder.encode(value).byteLength <= 1600)
  .regex(/^[^\p{Cc}]*$/u)

type Source = { title: string; url: string; snippet: string }
function normalize(payload: unknown) {
  const parsed = providerPayload.parse(payload)
  const results: Source[] = []
  let truncated = false
  for (const entry of parsed.results) {
    const source = normalizeWebSource({
      title: plainText(entry.title, 256),
      url: entry.url,
    })
    if (!source || results.length === WEB_SOURCES_PER_SEARCH) {
      truncated = true
      continue
    }
    const title = source.title
    const url = source.url
    const snippet = plainText(entry.content, 1500)
    if (!title || !snippet) {
      truncated = true
      continue
    }
    truncated ||= title !== entry.title || snippet !== entry.content
    results.push({ title, url, snippet })
  }
  const searchedAt = new Date().toISOString()
  // Budget with the longer status spelling before forming the final result.
  while (
    encoder.encode(
      JSON.stringify({ provider: 'tavily', status: 'empty', searchedAt, results, truncated }),
    ).byteLength > searchLimits.toolOutputBytes
  ) {
    results.pop()
    truncated = true
  }
  return {
    provider: 'tavily' as const,
    status: results.length ? ('ok' as const) : ('empty' as const),
    searchedAt,
    results,
    truncated,
  }
}

// The loop stays inside its owning try/finally so every exit joins cancellation
// and releases the reader; splitting it would obscure resource ownership.
/* oxlint-disable max-depth */
async function boundedBody(response: Response, signal: AbortSignal) {
  if (!response.body) throw new Error(unavailable)
  const reader = response.body.getReader()
  let canceling: Promise<void> | undefined
  const cancel = () => {
    canceling ??= reader.cancel().catch(() => {})
  }
  signal.addEventListener('abort', cancel, { once: true })
  const chunks: Uint8Array[] = []
  let size = 0
  let complete = false
  try {
    if (signal.aborted) cancel()
    signal.throwIfAborted()
    while (true) {
      const chunk = await reader.read()
      signal.throwIfAborted()
      if (chunk.done) {
        complete = true
        break
      }
      size += chunk.value.byteLength
      if (size > searchLimits.providerBodyBytes) throw new Error(unavailable)
      chunks.push(chunk.value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const payload: unknown = JSON.parse(text)
    return payload
  } finally {
    signal.removeEventListener('abort', cancel)
    if (!complete) cancel()
    await canceling
    reader.releaseLock()
  }
}

/* oxlint-enable max-depth */

function searchUnavailable(error: string) {
  return { provider: 'tavily' as const, status: 'unavailable' as const, error }
}

/** Own one dispatched request through response admission and actual cleanup. */
async function requestTavily(
  query: string,
  {
    transport,
    headers,
    ownerSignal,
    callerSignal,
    closeGate,
    onSources,
  }: Readonly<{
    transport: NonNullable<WebSearchConfig['transport']>
    headers: HeadersInit
    ownerSignal: AbortSignal
    callerSignal: AbortSignal
    closeGate: () => void
    onSources: (sources: readonly WebSource[]) => void
  }>,
) {
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(), searchLimits.requestTimeoutMs)
  const signal = AbortSignal.any([ownerSignal, callerSignal, deadline.signal])
  let body: ReadableStream<Uint8Array> | null = null
  try {
    signal.throwIfAborted()
    const response = await transport(endpoint, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers,
      body: JSON.stringify({
        query,
        search_depth: 'basic',
        auto_parameters: false,
        max_results: 5,
        chunks_per_source: 3,
        include_answer: false,
        include_raw_content: false,
        include_images: false,
        topic: 'general',
      }),
    })
    body = response.body
    signal.throwIfAborted()
    // Close synchronously, before refused-response cleanup can block another call.
    if ([401, 403, 429, 432, 433].includes(response.status)) closeGate()
    if (!response.ok) return searchUnavailable(unavailable)
    const payload = await boundedBody(response, signal)
    signal.throwIfAborted()
    const normalized = normalize(payload)
    onSources(normalized.results.map(({ title, url }) => ({ title, url })))
    return normalized
  } catch {
    ownerSignal.throwIfAborted()
    callerSignal.throwIfAborted()
    return searchUnavailable(deadline.signal.aborted ? 'Web search timed out.' : unavailable)
  } finally {
    // Await actual body/transport cleanup, never race-and-detach IO.
    await body?.cancel().catch(() => {})
    clearTimeout(timer)
    ownerSignal.throwIfAborted()
    callerSignal.throwIfAborted()
  }
}

/** Per-turn search authority. Failed dispatches consume quota; native wrappers own presentation. */
export function assignWebSearch(
  config: WebSearchConfig,
  ownerSignal: AbortSignal,
  onSources: (sources: readonly WebSource[]) => void = () => {},
) {
  if (config.authMode === 'key' && !config.apiKey?.trim())
    throw new Error('Web search key required.')
  const transport = config.transport ?? fetch
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (config.authMode === 'keyless') headers['X-Tavily-Access-Mode'] = 'keyless'
  else headers.Authorization = `Bearer ${config.apiKey}`
  let dispatched = 0
  let closed = false
  return async (input: unknown, callerSignal = ownerSignal) => {
    ownerSignal.throwIfAborted()
    callerSignal.throwIfAborted()
    const query = searchQuery.safeParse(input)
    if (!query.success) return searchUnavailable('Invalid search query.')
    if (closed) return searchUnavailable(unavailable)
    if (dispatched >= searchLimits.requestsPerTurn)
      return searchUnavailable('Search limit reached for this turn.')
    // Reserve before the first await; failed/ambiguous requests consume quota.
    dispatched++
    return await requestTavily(query.data, {
      transport,
      headers,
      ownerSignal,
      callerSignal,
      onSources,
      closeGate: () => {
        closed = true
      },
    })
  }
}
