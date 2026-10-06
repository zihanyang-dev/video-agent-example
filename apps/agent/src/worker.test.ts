import { expect, test } from 'bun:test'
import { connectObjects } from '@vid/object-storage'
import { WorkerProcess } from './worker'

test('worker installs one cleanup receipt before abort listeners can reenter close', async () => {
  // Real native owners, never connected or dispatched. No external request.
  const objects = connectObjects({
    endpoint: 'http://127.0.0.1:1',
    region: 'fixture',
    bucket: 'fixture',
    accessKeyID: 'fixture',
    secretAccessKey: 'fixture',
  })
  const worker = new WorkerProcess(
    {
      DATABASE_URL:
        'postgres://fixture:fixture@127.0.0.1:1/fixture?sslmode=disable',
      REDIS_URL: 'redis://127.0.0.1:1',
      IO_TIMEOUT_MS: 1000,
    },
    undefined,
    objects,
  )
  let reentrant: Promise<void> | undefined
  worker.signal.addEventListener(
    'abort',
    () => {
      reentrant = worker.close()
    },
    { once: true },
  )
  const closing = worker.close()
  try {
    expect(reentrant).toBe(closing)
    await closing
    expect(worker.close()).toBe(closing)
    await worker.stop()
    expect(worker.commands.isOpen).toBe(false)
    expect(worker.blockingReader.isOpen).toBe(false)
  } finally {
    await Promise.allSettled([closing, reentrant, worker.stop()])
  }
})
