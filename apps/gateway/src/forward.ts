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
import { Hono, type Context } from 'hono'
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

  /**
   * Fetches a finished result on the sandbox's behalf.
   *
   * Registered before the general route because it is the one path that is ours rather than
   * the provider's. A generation answers with a link to a CDN and the sandbox has no route
   * off its network, so the bytes come back through here.
   *
   * Only hosts this deployment named, and only https. Anything else and this is an open
   * proxy sitting inside our network, reachable by whatever command a model decided to run.
   */
  app.get('/:provider/_result', (context) =>
    fetchResult(parts, context, context.req.param('provider')),
  )

  app.all('/:provider/*', async (context) => {
    const token = await parts.readToken(context.req.header('authorization'))
    if (token === null) return context.text('not a usable turn token', 401)

    const name = context.req.param('provider')
    const provider = parts.providers[name]
    // Named rather than hidden: a skill calling a provider nobody configured is a mistake
    // in the skill, and "404" would send its author looking at the provider's docs.
    if (provider === undefined) return context.text(`no provider called ${name}`, 404)

    const path = context.req.path.slice(`/${name}`.length)

    const sending = await checked(context.req.raw, provider.models)
    if (sending.refused !== null) {
      return context.text(
        `this deployment does not pay for ${sending.refused}. It pays for: ${(provider.models ?? []).join(', ')}`,
        403,
      )
    }

    parts.onSpend(token, name, path)

    const answered = await fetch(`${provider.baseUrl}${path}${searchOf(context.req.url)}`, {
      method: context.req.method,
      headers: { ...passedThrough(context.req.raw.headers), [provider.header]: provider.key },
      body: sending.body,
      // Node and Bun both require this once a body is a stream.
      ...(sending.body instanceof ReadableStream ? { duplex: 'half' } : {}),
    } as RequestInit)

    return new Response(answered.body, {
      status: answered.status,
      statusText: answered.statusText,
      headers: decoded(answered.headers),
    })
  })

  return app
}

/**
 * Looks at one field, and only when this deployment said which models it pays for.
 *
 * This is the single exception to forwarding bytes unread, and it is deliberately the
 * smallest one that closes the hole: a name is compared against a list, nothing about the
 * request is understood, and a provider that renames a field elsewhere changes nothing here.
 * A request that names no model is forwarded -- polling a task and fetching a result both
 * have to keep working, and neither of them buys anything.
 *
 * Reading the body costs the streaming path, which is why it only happens when a list is
 * configured. Generation requests are a few hundred bytes; results come back the other way.
 */
const checked = async (
  request: Request,
  allowed: readonly string[] | undefined,
): Promise<{ body: ReadableStream | string | null; refused: string | null }> => {
  if (allowed === undefined || request.body === null) {
    return { body: request.body, refused: null }
  }

  const raw = await request.text()
  const named = modelNamedIn(raw)

  if (named === null || allowed.includes(named)) return { body: raw, refused: null }
  return { body: raw, refused: named }
}

/** Null when the body is not JSON, or is JSON that names no model. */
const modelNamedIn = (raw: string): string | null => {
  try {
    const named = (JSON.parse(raw) as { model?: unknown }).model
    return typeof named === 'string' ? named : null
  } catch {
    return null
  }
}

const fetchResult = async (
  parts: ForwardParts,
  context: Context,
  name: string,
): Promise<Response> => {
  const token = await parts.readToken(context.req.header('authorization'))
  if (token === null) return context.text('not a usable turn token', 401)

  const provider = parts.providers[name]
  if (provider === undefined) return context.text(`no provider called ${name}`, 404)

  const asked = context.req.query('url')
  if (asked === undefined) return context.text('a url is required', 400)
  if (!allowed(asked, provider.results)) {
    return context.text('this deployment does not fetch results from there', 403)
  }

  parts.onSpend(token, name, '/_result')

  // No credential attached: these links carry their own, and adding ours would hand a
  // provider key's authority to whoever could get a URL in front of this.
  const answered = await fetch(asked, { redirect: 'follow' })
  return new Response(answered.body, {
    status: answered.status,
    headers: decoded(answered.headers),
  })
}

/** False for anything that is not https at a host this deployment named. */
const allowed = (asked: string, hosts: readonly string[] | undefined): boolean => {
  if (hosts === undefined || hosts.length === 0) return false

  try {
    const url = new URL(asked)
    return url.protocol === 'https:' && hosts.includes(url.hostname)
  } catch {
    return false
  }
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
