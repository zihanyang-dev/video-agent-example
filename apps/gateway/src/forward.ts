/**
 * Stands between a command a model wrote and the money it can spend.
 *
 * A sandbox runs whatever the agent decided to run, so it cannot hold a provider key. It
 * holds a token good for one turn and calls here; this attaches the real credential and
 * forwards. That is the entire reason this is a separate process (architecture.md §1).
 *
 * It does not understand the request or the response. It reads the first path segment to
 * pick a provider and passes the rest through untouched -- a gateway that parsed payloads
 * would need updating every time a provider changed one, and would be a place for a bug to
 * decide what a skill is allowed to ask for.
 */
import type { TurnToken } from '@vid/turn-token'
import { Hono } from 'hono'
import type { Providers } from './providers'

export type ForwardParts = {
  providers: Providers
  /** Null when the token is missing, malformed, tampered with or expired. */
  readToken: (header: string | undefined) => Promise<TurnToken | null>
  /** Where a turn's spending is recorded. Called before the request goes out. */
  onSpend: (token: TurnToken, provider: string, path: string) => void
}

/** Headers that belong to the hop, not the message. Forwarding them corrupts the next one. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
  'authorization',
])

export const createForwarder = (parts: ForwardParts): Hono => {
  const app = new Hono()

  app.all('/:provider/*', async (context) => {
    const token = await parts.readToken(context.req.header('authorization'))
    if (token === null) return context.text('not a usable turn token', 401)

    const name = context.req.param('provider')
    const provider = parts.providers[name]
    // Named rather than hidden: a skill calling a provider nobody configured is a mistake
    // in the skill, and "404" would send its author looking at the provider's docs.
    if (provider === undefined) return context.text(`no provider called ${name}`, 404)

    const path = context.req.path.slice(`/${name}`.length)
    parts.onSpend(token, name, path)

    const answered = await fetch(`${provider.baseUrl}${path}${searchOf(context.req.url)}`, {
      method: context.req.method,
      headers: { ...passedThrough(context.req.raw.headers), [provider.header]: provider.key },
      body: context.req.raw.body,
      // Node and Bun both require this once a body is a stream.
      ...(context.req.raw.body === null ? {} : { duplex: 'half' }),
    } as RequestInit)

    return new Response(answered.body, {
      status: answered.status,
      statusText: answered.statusText,
      headers: decoded(answered.headers),
    })
  })

  return app
}

const searchOf = (url: string): string => new URL(url).search

/**
 * `fetch` decompresses on the way in, so the body leaving here is plain even when the
 * upstream one was not. Passing the encoding headers along would tell the caller to
 * decompress something already decompressed -- which is a ZlibError on the first real call,
 * not a subtle degradation.
 */
const decoded = (headers: Headers): Headers => {
  const copy = new Headers(headers)
  copy.delete('content-encoding')
  copy.delete('content-length')
  return copy
}

const passedThrough = (headers: Headers): Record<string, string> => {
  const kept: Record<string, string> = {}
  for (const [name, value] of headers) {
    if (!HOP_BY_HOP.has(name.toLowerCase())) kept[name] = value
  }
  return kept
}
