/**
 * Attaches provider credentials only after authenticating the sandbox's turn token.
 *
 * Provider routes preserve request bodies unless a model allowlist requires reading the
 * top-level model field. Result downloads have a separate rule: every redirect must remain
 * within the configured origins, and no provider credential accompanies those downloads.
 */
import type { TurnToken } from '@vid/turn-token'
import { Hono, type Context } from 'hono'
import type { Providers } from '../providers/providers'

export type ForwardingOptions = {
  providers: Providers
  /** Null when the token is missing, malformed, tampered with or expired. */
  readToken: (header: string | undefined) => Promise<TurnToken | null>
  /** Records an authorized request attempt, including polling; it is not a billing receipt. */
  onForwardRequest: (token: TurnToken, provider: string, path: string) => void
}

/** Strip transport headers and the sandbox token before attaching the provider credential. */
const EXCLUDED_REQUEST_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
  'authorization',
])

export const createForwarder = (options: ForwardingOptions): Hono => {
  const app = new Hono()

  /**
   * Fetches a finished result on the sandbox's behalf.
   *
   * Registered before the general route because it is the one path that is ours rather than
   * the provider's. A generation answers with a link to a CDN and the sandbox has no route
   * off its network, so the bytes come back through here.
   *
   * Only exact origins this deployment named. The scheme is part of the configured origin,
   * so development can use HTTP without allowing arbitrary destinations in production.
   */
  app.get('/:provider/_result', (context) =>
    fetchResult(options, context, context.req.param('provider')),
  )

  app.all('/:provider/*', async (context) => {
    const token = await options.readToken(context.req.header('authorization'))
    if (token === null) return context.text('not a usable turn token', 401)

    const name = context.req.param('provider')
    const provider = options.providers[name]
    // Named rather than hidden: a skill calling a provider nobody configured is a mistake
    // in the skill, and "404" would send its author looking at the provider's docs.
    if (provider === undefined) return context.text(`no provider called ${name}`, 404)

    const path = context.req.path.slice(`/${name}`.length)
    const query = new URL(context.req.url).search

    const requestBody = await prepareRequestBody(context.req.raw, provider.models)
    if (requestBody.refusedModel !== null) {
      return context.text(
        `this deployment does not pay for ${requestBody.refusedModel}. It pays for: ${(provider.models ?? []).join(', ')}`,
        403,
      )
    }

    options.onForwardRequest(token, name, path)

    const upstream = await fetch(`${provider.baseUrl}${path}${query}`, {
      method: context.req.method,
      headers: { ...requestHeaders(context.req.raw.headers), [provider.header]: provider.key },
      body: requestBody.body,
      // Node and Bun both require this once a body is a stream.
      ...(requestBody.body instanceof ReadableStream ? { duplex: 'half' } : {}),
    } as RequestInit)

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders(upstream.headers),
    })
  })

  return app
}

/**
 * Applies the configured allowlist to a top-level string model field.
 *
 * Requests without that field remain opaque, including polling requests and non-JSON
 * bodies. This is a model-name restriction for providers that use that field; it does not
 * validate arbitrary provider operations or infer their cost.
 *
 * Reading the body removes its streaming behavior, so unrestricted providers keep the
 * original stream. Restricted requests reuse the text that was read for the comparison.
 */
const prepareRequestBody = async (
  request: Request,
  allowedModels: readonly string[] | undefined,
): Promise<{ body: ReadableStream | string | null; refusedModel: string | null }> => {
  if (allowedModels === undefined || request.body === null) {
    return { body: request.body, refusedModel: null }
  }

  const raw = await request.text()
  const modelName = readModelName(raw)

  if (modelName === null || allowedModels.includes(modelName))
    return { body: raw, refusedModel: null }
  return { body: raw, refusedModel: modelName }
}

/** Null when the body is not JSON, or is JSON that names no model. */
const readModelName = (raw: string): string | null => {
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    // Non-JSON bodies remain opaque to the gateway and are forwarded to the provider.
    return null
  }

  if (typeof body !== 'object' || body === null || !('model' in body)) return null
  return typeof body.model === 'string' ? body.model : null
}

const fetchResult = async (
  options: ForwardingOptions,
  context: Context,
  name: string,
): Promise<Response> => {
  const token = await options.readToken(context.req.header('authorization'))
  if (token === null) return context.text('not a usable turn token', 401)

  const provider = options.providers[name]
  if (provider === undefined) return context.text(`no provider called ${name}`, 404)

  const requestedUrl = context.req.query('url')
  if (requestedUrl === undefined) return context.text('a url is required', 400)
  if (!isAllowedOrigin(requestedUrl, provider.results)) {
    return context.text('this deployment does not fetch results from there', 403)
  }

  options.onForwardRequest(token, name, '/_result')

  const upstream = await fetchAllowedRedirects(requestedUrl, provider.results)
  if (upstream === null) return context.text('that redirected somewhere we do not fetch', 403)

  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders(upstream.headers),
  })
}

/**
 * Fetches, checking every hop rather than only the first.
 *
 * `redirect: 'follow'` would make the allowlist a statement about one URL instead of about
 * where the bytes come from: a host we trust could redirect anywhere, and "anywhere" from
 * inside this network includes addresses nothing outside it can reach. Null when a hop
 * leaves the list or the four-request limit is exhausted.
 *
 * No credential is attached at any hop: these links carry their own, and adding ours would
 * hand a provider key's authority to whoever could get a URL in front of this.
 */
const fetchAllowedRedirects = async (
  initialUrl: string,
  origins: readonly string[] | undefined,
): Promise<Response | null> => {
  let currentUrl = initialUrl

  for (let hop = 0; hop < 4; hop++) {
    const upstream = await fetch(currentUrl, { redirect: 'manual' })

    const moved = upstream.headers.get('location')
    if (upstream.status < 300 || upstream.status > 399 || moved === null) return upstream

    const next = new URL(moved, currentUrl).href
    if (!isAllowedOrigin(next, origins)) return null
    currentUrl = next
  }

  return null
}

/**
 * False for anything that is not at an origin this deployment named.
 *
 * Origins rather than hostnames, so the scheme is part of what was named rather than a
 * separate rule remembered somewhere else. `http://` somewhere internal and `https://` at
 * the same name are different places, and a list of bare hostnames cannot say which one it
 * meant.
 */
const isAllowedOrigin = (requestedUrl: string, origins: readonly string[] | undefined): boolean => {
  if (origins === undefined || origins.length === 0) return false

  try {
    return origins.includes(new URL(requestedUrl).origin)
  } catch {
    // An invalid URL cannot match a configured origin; the caller receives the same refusal.
    return false
  }
}

/**
 * `fetch` decompresses on the way in, so the body leaving here is plain even when the
 * upstream one was not. Passing the encoding headers along would tell the caller to
 * decompress something already decompressed -- which is a ZlibError on the first real call,
 * not a subtle degradation.
 */
const responseHeaders = (headers: Headers): Headers => {
  const copy = new Headers(headers)
  copy.delete('content-encoding')
  copy.delete('content-length')
  return copy
}

const requestHeaders = (headers: Headers): Record<string, string> => {
  const kept: Record<string, string> = {}
  for (const [name, value] of headers) {
    if (!EXCLUDED_REQUEST_HEADERS.has(name.toLowerCase())) kept[name] = value
  }
  return kept
}
