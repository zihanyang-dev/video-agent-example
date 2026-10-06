import { expect, test } from 'bun:test'
import { serveWorkerHealth, type WorkerHealth } from './worker-health'

test('loopback health listener separates liveness from readiness and only serves GET probes', async () => {
  const facts: WorkerHealth = {
    live: true,
    ready: false,
    phase: 'starting',
  }
  const http = serveWorkerHealth(() => facts, 0)
  const second = serveWorkerHealth(() => ({ ...facts, ready: true }), 0)
  const url = `http://127.0.0.1:${http.port}`
  try {
    expect(http.hostname).toBe('127.0.0.1')
    expect(second.port).not.toBe(http.port)
    expect((await fetch(`${url}/livez`)).status).toBe(200)
    const ready = await fetch(`${url}/readyz`)
    expect(ready.status).toBe(503)
    expect(ready.headers.get('cache-control')).toBe('no-store')
    expect(await ready.json()).toEqual(facts)
    expect((await fetch(`${url}/readyz`, { method: 'POST' })).status).toBe(404)
    expect((await fetch(`${url}/private`)).status).toBe(404)
  } finally {
    await Promise.allSettled([http.stop(true), second.stop(true)])
  }
})
