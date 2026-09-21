/**
 * Serves the page and passes `/api` through to the server app.
 *
 * A separate process from the API for the same reason the API is separate from the agent:
 * different lifetimes. A style fix ships the bundle and nothing else restarts, and the API
 * restarting does not take the page down with it (architecture.md §1).
 *
 * The proxy is here rather than as CORS on the API because it makes the browser's world one
 * origin. Cookies, `EventSource` and the fetch calls all behave without a policy to get
 * right, and the API never learns which origins exist.
 *
 * No bundler config: Bun builds what `index.html` imports, and serves it hashed in
 * production and hot-reloaded under `--hot`.
 */
import index from '../index.html'
import { readEnv } from './env'

const env = readEnv()

const server = Bun.serve({
  port: env.PORT,
  // Long-lived by nature: an SSE connection is idle whenever the agent is thinking, which
  // for this work is most of the time.
  idleTimeout: 0,
  development: env.NODE_ENV !== 'production',

  routes: {
    '/api/*': (request) => {
      const incomingUrl = new URL(request.url)
      const upstreamUrl = new URL(
        incomingUrl.pathname.slice('/api'.length) + incomingUrl.search,
        env.API_URL,
      )

      const headers = new Headers(request.headers)
      headers.set('x-user-id', env.WEB_USER)

      return fetch(upstreamUrl, {
        method: request.method,
        headers,
        body: request.body,
        // Streams both ways: the response is an event stream and must not be buffered.
        ...(request.body === null ? {} : { duplex: 'half' }),
        signal: request.signal,
      } as RequestInit)
    },

    '/*': index,
  },
})

console.log(`web on ${server.port}, api at ${env.API_URL}`)
