export type WorkerHealth = Readonly<{
  live: boolean
  ready: boolean
  phase: 'starting' | 'ready' | 'stopping' | 'failed'
}>

/** Production main owns this listener; library workers allocate no HTTP port. */
export function serveWorkerHealth(health: () => WorkerHealth, port = 8788) {
  return Bun.serve({
    hostname: '127.0.0.1',
    port,
    fetch(request) {
      const path = new URL(request.url).pathname
      if (request.method !== 'GET' || (path !== '/livez' && path !== '/readyz'))
        return new Response(null, { status: 404 })
      const facts = health()
      return Response.json(facts, {
        status: (path === '/livez' ? facts.live : facts.ready) ? 200 : 503,
        headers: { 'Cache-Control': 'no-store' },
      })
    },
  })
}
