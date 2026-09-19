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

const PORT = Number(process.env['PORT'] ?? 3000)
const API = process.env['API_URL'] ?? 'http://localhost:8787'

/**
 * Who the browser is, decided here.
 *
 * A stand-in, and the only one in this repository. Signing in belongs at this edge -- it is
 * the process the browser talks to -- so when it is real it replaces this line and nothing
 * else moves. Two things become true on that day and are not true now: the API must stop
 * being reachable from anywhere but here, because it believes this header; and this must
 * read a session rather than an environment variable.
 */
const WHO = process.env['WEB_USER'] ?? 'dev'

const server = Bun.serve({
  port: PORT,
  // Long-lived by nature: an SSE connection is idle whenever the agent is thinking, which
  // for this work is most of the time.
  idleTimeout: 0,
  development: process.env['NODE_ENV'] !== 'production',

  routes: {
    '/api/*': (request) => {
      const here = new URL(request.url)
      const there = new URL(here.pathname.slice('/api'.length) + here.search, API)

      const headers = new Headers(request.headers)
      headers.set('x-user-id', WHO)

      return fetch(there, {
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

console.log(`web on ${server.port}, api at ${API}`)
