import { expect, spyOn, test } from 'bun:test'
import { connectObjects } from '@vid/object-storage'
import { WorkerProcess } from './worker'

const connections = {
  DATABASE_URL: 'postgres://fixture:fixture@127.0.0.1:1/fixture?sslmode=disable',
  REDIS_URL: 'redis://127.0.0.1:1',
  IO_TIMEOUT_MS: 1000,
}

function rejectionLeaves(reason: unknown): unknown[] {
  if (!(reason instanceof AggregateError)) return [reason]
  return reason.errors.flatMap((cause: unknown) => rejectionLeaves(cause))
}

for (const scenario of [
  {
    name: 'both rejected',
    listener: false,
    external: false,
    second: new Error('reader refused'),
  },
  {
    name: 'listener abort',
    listener: true,
    external: false,
    second: new Error('reader refused'),
  },
  {
    name: 'listener and undefined',
    listener: true,
    external: false,
    second: undefined,
  },
  {
    name: 'external abort',
    listener: false,
    external: true,
    second: new Error('reader refused'),
  },
]) {
  test(`worker connection supervision retains both receipts after ${scenario.name}`, async () => {
    const external = new AbortController()
    const worker = new WorkerProcess(connections, external.signal)
    const first = new Error('commands refused')
    const started = Promise.withResolvers<void>()
    const reader = Promise.withResolvers<void>()
    const commandsConnect = spyOn(worker.commands, 'connect').mockImplementation(async () => {
      await started.promise
      if (scenario.listener) worker.commands.emit('error', first)
      throw first
    })
    const readerConnect = spyOn(worker.blockingReader, 'connect').mockImplementation(async () => {
      started.resolve()
      await reader.promise
      throw scenario.second
    })
    const connecting = worker.connect().then(
      () => ({ rejected: false, reason: undefined }),
      (reason: unknown) => ({ rejected: true, reason }),
    )
    let settled = false
    const completion = worker.done.then(
      () => {
        settled = true
        return undefined
      },
      (reason: unknown) => {
        settled = true
        return reason
      },
    )
    try {
      await started.promise
      if (scenario.external) external.abort()
      await Bun.sleep(0)
      expect(settled).toBe(false)
      reader.resolve()
      const connection = await connecting
      expect(connection.rejected).toBe(true)
      if (scenario.listener || scenario.external) {
        expect(connection.reason).toBe(worker.signal.reason)
      } else {
        expect(connection.reason).toBeInstanceOf(AggregateError)
        expect(rejectionLeaves(connection.reason)).toEqual([first, scenario.second])
      }
      const failure = await completion
      expect(failure).toBeInstanceOf(AggregateError)
      expect(rejectionLeaves(failure)).toContain(first)
      expect(rejectionLeaves(failure)).toContain(scenario.second)
      expect(await worker.stop().catch((reason: unknown) => reason)).toBe(failure)
    } finally {
      started.resolve()
      reader.resolve()
      await Promise.allSettled([connecting, completion, worker.stop()])
      commandsConnect.mockRestore()
      readerConnect.mockRestore()
    }
  })
}

test('worker does not become ready just because intake was marked started', async () => {
  const worker = new WorkerProcess(connections)
  try {
    expect(worker.health()).toEqual({
      live: true,
      ready: false,
      phase: 'starting',
    })
    worker.markReady()
    expect(worker.health()).toEqual({
      live: true,
      ready: false,
      phase: 'starting',
    })
    await worker.stop()
    expect(worker.health()).toEqual({
      live: false,
      ready: false,
      phase: 'stopping',
    })
  } finally {
    await worker.stop()
  }
})

test('an owned task failure remains failed rather than stopping after abort', async () => {
  const worker = new WorkerProcess(connections)
  const cause = new Error('Owned task failed')
  worker.own(Promise.reject(cause))
  try {
    await worker.done
    throw new Error('Owned task unexpectedly succeeded')
  } catch (failure) {
    expect(failure).toBeInstanceOf(AggregateError)
    if (!(failure instanceof AggregateError)) throw new Error('Expected aggregate')
    expect(failure.errors).toEqual([cause])
    expect(worker.health()).toEqual({
      live: false,
      ready: false,
      phase: 'failed',
    })
  } finally {
    await Promise.allSettled([worker.stop()])
  }
})

test('worker close drains owned work before closing object storage', async () => {
  const events: string[] = []
  const objects = connectObjects({
    endpoint: 'http://127.0.0.1:1',
    region: 'fixture',
    bucket: 'fixture',
    accessKeyID: 'fixture',
    secretAccessKey: 'fixture',
  })
  const worker = new WorkerProcess(connections, undefined, {
    ...objects,
    close() {
      events.push('objects-closed')
      objects.close()
    },
  })
  const gate = Promise.withResolvers<void>()
  async function ownedWork() {
    await gate.promise
    events.push('task-finished')
  }
  worker.own(ownedWork())
  const closing = worker.close()
  try {
    await Bun.sleep(0)
    expect(events).toEqual([])
    gate.resolve()
    await closing
    expect(events).toEqual(['task-finished', 'objects-closed'])
    await worker.stop()
  } finally {
    gate.resolve()
    await Promise.allSettled([closing, worker.stop()])
  }
})

test('worker installs one cleanup receipt before abort listeners can reenter close', async () => {
  // Real native owners, never connected or dispatched. No external request.
  const objects = connectObjects({
    endpoint: 'http://127.0.0.1:1',
    region: 'fixture',
    bucket: 'fixture',
    accessKeyID: 'fixture',
    secretAccessKey: 'fixture',
  })
  const worker = new WorkerProcess(connections, undefined, objects)
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
