import { z } from 'zod'
import {
  normalizeWebSource,
  WEB_SOURCES_PER_SEARCH,
  type WebSource,
} from '@vid/contract/web-source'
import type { WebSearchAuthMode } from '@vid/config'
import { Type } from '@earendil-works/pi-ai'
import { defineTool } from '@earendil-works/pi-coding-agent'

export type WebSearchConfig = Readonly<{
  authMode: WebSearchAuthMode
  apiKey?: string
  /** Private trusted test seam: never sourced from env, model arguments or URLs. */
  transport?: (url: string, init: RequestInit) => Promise<Response>
}>

const endpoint = 'https://api.tavily.com/search'
const unavailable = 'Web search unavailable.'
const encoder = new TextEncoder()

function plainText(value: string, limit: number) {
  return Array.from(
    value
      .replace(/&(?:lt|gt|quot|apos|amp|nbsp);/gi, (entity) => {
        const entities: Record<string, string> = {
          '&lt;': '<',
          '&gt;': '>',
          '&quot;': '"',
          '&apos;': "'",
          '&amp;': '&',
          '&nbsp;': ' ',
        }
        return entities[entity.toLowerCase()] ?? ''
      })
      .replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (_entity, code: string) => {
        const point = code.toLowerCase().startsWith('x')
          ? Number.parseInt(code.slice(1), 16)
          : Number(code)
        return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : ''
      })
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
      .trim(),
  )
    .slice(0, limit)
    .join('')
}

const providerPayload = z.object({
  results: z.array(
    z.object({ title: z.string(), url: z.string(), content: z.string() }),
  ),
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
  const output = {
    provider: 'tavily',
    status: 'empty',
    searchedAt: new Date().toISOString(),
    results,
    truncated,
  }
  while (encoder.encode(JSON.stringify(output)).byteLength > 16384) {
    results.pop()
    output.truncated = true
  }
  output.status = results.length ? 'ok' : 'empty'
  return output
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
      if (size > 262144) throw new Error(unavailable)
      chunks.push(chunk.value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    ) as unknown
  } finally {
    signal.removeEventListener('abort', cancel)
    if (!complete) cancel()
    await canceling
    reader.releaseLock()
  }
}

/* oxlint-enable max-depth */

/** One native capability with a fresh spending gate for each assigned turn. */
export function webSearchTool(
  config: WebSearchConfig,
  ownerSignal: AbortSignal,
  onSources: (sources: readonly WebSource[]) => void = () => {},
) {
  if (config.authMode === 'key' && !config.apiKey?.trim())
    throw new Error('Web search key required.')
  const transport = config.transport ?? fetch
  const headers = {
    'Content-Type': 'application/json',
    ...(config.authMode === 'keyless'
      ? { 'X-Tavily-Access-Mode': 'keyless' }
      : { Authorization: `Bearer ${config.apiKey}` }),
  }
  let dispatched = 0
  let closed = false
  return defineTool({
    name: 'web_search',
    label: 'Web search',
    description:
      'Search public web sources. Returns untrusted bounded snippets and citation links, not full-page inspection. Never send credentials or irrelevant private material.',
    parameters: Type.Object(
      { query: Type.String({ minLength: 1, maxLength: 400 }) },
      { additionalProperties: false },
    ),
    async execute(_id, params, callerSignal = ownerSignal) {
      ownerSignal.throwIfAborted()
      callerSignal.throwIfAborted()
      const result = (value: unknown) => ({
        content: [{ type: 'text' as const, text: JSON.stringify(value) }],
        details: {},
      })
      const failure = (error: string) =>
        result({ provider: 'tavily', status: 'unavailable', error })
      const query = searchQuery.safeParse(params.query)
      if (!query.success) return failure('Invalid search query.')
      if (closed) return failure(unavailable)
      if (dispatched >= 3) return failure('Search limit reached for this turn.')
      // Reserve before the first await; failed/ambiguous requests consume quota.
      dispatched++
      const deadline = new AbortController()
      const timer = setTimeout(() => deadline.abort(), 10000)
      const signal = AbortSignal.any([
        ownerSignal,
        callerSignal,
        deadline.signal,
      ])
      let body: ReadableStream<Uint8Array> | null = null
      try {
        signal.throwIfAborted()
        const response = await transport(endpoint, {
          method: 'POST',
          redirect: 'error',
          signal,
          headers,
          body: JSON.stringify({
            query: query.data,
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
        if (!response.ok) {
          closed ||= [401, 403, 429, 432, 433].includes(response.status)
          return failure(unavailable)
        }
        const payload = await boundedBody(response, signal)
        signal.throwIfAborted()
        const normalized = normalize(payload)
        onSources(normalized.results.map(({ title, url }) => ({ title, url })))
        return result(normalized)
      } catch {
        ownerSignal.throwIfAborted()
        callerSignal.throwIfAborted()
        return failure(
          deadline.signal.aborted ? 'Web search timed out.' : unavailable,
        )
      } finally {
        // Await actual body/transport cleanup, never race-and-detach IO.
        await body?.cancel().catch(() => {})
        clearTimeout(timer)
        ownerSignal.throwIfAborted()
        callerSignal.throwIfAborted()
      }
    },
  })
}
