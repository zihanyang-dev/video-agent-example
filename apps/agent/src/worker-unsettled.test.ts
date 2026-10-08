import { expect, test } from 'bun:test'
import { readWorkerEnv } from '@vid/config'
import { bindConfiguredSandbox, WorkerProcess } from './worker'

const connections = {
  DATABASE_URL: 'postgres://fixture:fixture@127.0.0.1:1/fixture?sslmode=disable',
  REDIS_URL: 'redis://127.0.0.1:1',
  IO_TIMEOUT_MS: 1000,
}

test('configured E2B heartbeat fails the shared owner while model inference is idle', async () => {
  const paths: string[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname
      paths.push(path)
      if (path === '/v2/sandboxes')
        return Response.json({
          sandboxID: 'heartbeat',
          envdVersion: '0.6.2',
          envdAccessToken: 'fixture',
        })
      if (path.endsWith('/timeout')) return new Response(null, { status: 500 })
      if (path.endsWith('/pause')) return new Response(null, { status: 204 })
      return new Response(null, { status: 500 })
    },
  })
  const endpoint = `http://127.0.0.1:${server.port}`
  const worker = new WorkerProcess(connections)
  const fail = worker.fail
  let sandbox: import('./contract').SandboxSessionPort | undefined
  let failure: unknown
  const producer = Promise.withResolvers<void>()
  const inference = new Promise<void>((resolve) =>
    worker.signal.addEventListener(
      'abort',
      () => {
        producer.resolve()
        resolve()
      },
      { once: true },
    ),
  )
  worker.own(inference)
  try {
    sandbox = await bindConfiguredSandbox(
      {
        E2B_API_URL: endpoint,
        E2B_SANDBOX_URL: endpoint,
        E2B_API_KEY: 'fixture',
        E2B_TEMPLATE: 'fixture',
        SANDBOX_TIMEOUT_MS: 1000,
      },
      (error) => {
        failure = error
        fail(error)
      },
    )({ threadID: 'thread', runID: 'run', fence: 1 }, worker.signal)
    await Promise.race([producer.promise, Bun.sleep(2000)])
    expect(worker.signal.aborted).toBe(true)
    expect(failure).toBeInstanceOf(Error)
    expect(worker.health().phase).toBe('failed')
    expect(() => worker.claim({ ownerID: 'new-owner', leaseMs: 1000 })).toThrow()
    const result = await worker.done.catch((error: unknown) => error)
    expect(result).toBeInstanceOf(AggregateError)
    expect((result as AggregateError).errors).toContain(failure)
    expect(paths).toContain('/sandboxes/heartbeat/timeout')
  } finally {
    producer.resolve()
    await sandbox?.close().catch(() => {})
    await worker.stop().catch(() => {})
    await server.stop(true)
  }
})

test('failed configured prompt setup closes already allocated worker resources', async () => {
  const { spyOn } = await import('bun:test')
  const { startWorker } = await import('./worker')
  const stopping = spyOn(WorkerProcess.prototype, 'close')
  try {
    const env = readWorkerEnv({
      DATABASE_URL: connections.DATABASE_URL,
      REDIS_URL: connections.REDIS_URL,
      IO_TIMEOUT_MS: String(connections.IO_TIMEOUT_MS),
      MODEL_BASE_URL: 'http://127.0.0.1:1',
      MODEL_API_KEY: 'fixture',
      MODEL_ID: 'fixture',
      MODEL_CONTEXT_WINDOW: '8192',
      MODEL_MAX_OUTPUT_TOKENS: '1024',
      E2B_API_URL: 'http://127.0.0.1:1',
      E2B_SANDBOX_URL: 'http://127.0.0.1:1',
      E2B_API_KEY: 'fixture',
      MODEL_PROMPT_PATH: '/nonexistent-owned-fixture-prompt',
      OBJECT_STORAGE_URL: 'http://127.0.0.1:1',
      OBJECT_STORAGE_REGION: 'fixture',
      OBJECT_STORAGE_BUCKET: 'fixture',
      OBJECT_STORAGE_ACCESS_KEY_ID: 'fixture',
      OBJECT_STORAGE_SECRET_ACCESS_KEY: 'fixture',
    })
    const error = await startWorker(env).catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(Error)
    expect(stopping).toHaveBeenCalledTimes(1)
  } finally {
    stopping.mockRestore()
  }
})
