import { expect, test } from 'bun:test'
import { runWorker } from './run-loop'
import type {
  AgentHarness,
  ExecutionLease,
  ExecutionWrites,
  SandboxSessionPort,
} from '../contract.ts'

function controlledHarness() {
  const release = Promise.withResolvers<void>()
  const saturated = Promise.withResolvers<void>()
  let active = 0
  let peak = 0
  const harness: AgentHarness = {
    async run({ signal }) {
      active += 1
      peak = Math.max(peak, active)
      if (active === 2) saturated.resolve()
      await release.promise
      active -= 1
      signal.throwIfAborted()
      return { text: 'answer' }
    },
  }
  return { harness, release, saturated, peak: () => peak }
}

function recordingWrites() {
  const completed: string[] = []
  const interrupted: string[] = []
  const failed: string[] = []
  const writes: ExecutionWrites = {
    beginWorkspaceTransition: async () => true,
    settleWorkspaceTransition: async () => true,
    reserveModel: async () => 'allowed',
    beginEffect: async () => 'allowed',
    checkpoint: async () => true,
    rejectEffect: async () => true,
    saveSandbox: async () => true,
    quarantine: async () => {},
    renew: async () => 'renewed',
    appendText: async () => true,
    complete: async (lease) => {
      completed.push(lease.runID)
      return 'completed'
    },
    fail: async (lease, reason) => {
      if (reason === 'interrupted') interrupted.push(lease.runID)
      else failed.push(lease.runID)
      return 'failed'
    },
    cancel: async () => 'cancelled',
  }
  return { writes, completed, interrupted, failed }
}

function queuedClaims() {
  const leases: ExecutionLease[] = Array.from({ length: 3 }, (_, index) => ({
    runID: `run-${index}`,
    threadID: `thread-${index}`,
    text: 'hello',
    fence: 1,
    ownerID: 'worker',
    engine: 'pi',
    nativeSessionID: crypto.randomUUID(),
    deadlineAt: new Date(Date.now() + 60000),
    restoring: false,
    restoreWorkspace: false,
  }))
  const accepted: string[] = []
  async function claim(options: { ownerID: string; leaseMs: number }) {
    expect(options).toEqual({ ownerID: 'worker', leaseMs: 1000 })
    const lease = leases.shift() ?? null
    if (lease) accepted.push(lease.runID)
    return lease
  }
  return { accepted, claim }
}

function unusedTools(): SandboxSessionPort {
  return {
    nativeRef: { provider: 'e2b', id: 'fixture-native' },

    readBytes: async () => new Uint8Array(),
    writeBytes: async () => {},
    execute: async () => {
      throw new Error('Unexpected execute')
    },
    read: async () => {
      throw new Error('Unexpected read')
    },
    write: async () => {
      throw new Error('Unexpected write')
    },
    close: async () => {},
  }
}

function fixture() {
  const controller = new AbortController()
  const { harness, release, saturated, peak } = controlledHarness()
  const { writes, completed, interrupted, failed } = recordingWrites()
  const { claim, accepted } = queuedClaims()
  const deps = {
    writes,
    harness,
    claim,
    openSandbox: async () => unusedTools(),
  }
  const options = {
    ownerID: 'worker',
    concurrency: 2,
    leaseMs: 1000,
    pollMs: 5,
    signal: controller.signal,
  }
  return {
    controller,
    release,
    saturated,
    deps,
    options,
    accepted,
    completed,
    interrupted,
    failed,
    peak,
  }
}

test('worker bounds claims and waits for owned runs during shutdown', async () => {
  const f = fixture()
  const worker = runWorker(f.deps, f.options)
  let settled = false
  void worker.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    },
  )
  try {
    await f.saturated.promise
    expect(f.accepted).toEqual(['run-0', 'run-1'])
    expect(f.peak()).toBe(2)
    f.controller.abort()
    await Bun.sleep(20)
    expect(settled).toBe(false)
  } finally {
    f.controller.abort()
    f.release.resolve()
    await worker
  }
  expect(f.completed).toEqual([])
  expect(f.interrupted.sort()).toEqual(['run-0', 'run-1'])
})

test('a claim failure aborts and settles active runs before rejecting the worker', async () => {
  const f = fixture()
  const failure = new Error('Database unavailable')
  const claim = f.deps.claim
  const failed = Promise.withResolvers<void>()
  let attempts = 0
  f.deps.claim = async (options) => {
    attempts += 1
    if (attempts === 3) {
      failed.resolve()
      throw failure
    }
    return await claim(options)
  }
  f.options.concurrency = 3
  const worker = runWorker(f.deps, f.options)
  const observed = worker.catch((error: unknown) => error)
  try {
    await failed.promise
  } finally {
    f.release.resolve()
  }
  expect(await observed).toBe(failure)
  expect(f.completed).toEqual([])
  expect(f.interrupted.sort()).toEqual(['run-0', 'run-1'])
})

test('shutdown during an empty claim does not wait for the polling interval', async () => {
  const f = fixture()
  let claims = 0
  f.deps.claim = async () => {
    claims += 1
    f.controller.abort()
    return null
  }
  const worker = runWorker(f.deps, { ...f.options, pollMs: 60000 })
  const timeout = Promise.withResolvers<never>()
  const watchdog = setTimeout(
    () => timeout.reject(new Error('Idle worker did not settle after shutdown')),
    500,
  )
  try {
    await Promise.race([worker, timeout.promise])
    expect(claims).toBe(1)
    expect(f.accepted).toEqual([])
  } finally {
    clearTimeout(watchdog)
    f.controller.abort()
    f.release.resolve()
    await worker
  }
}, 1000)

test('each claimed run reads its current timeout without changing an active run', async () => {
  const f = fixture()
  const firstStarted = Promise.withResolvers<AbortSignal>()
  const secondStarted = Promise.withResolvers<AbortSignal>()
  const release = Promise.withResolvers<void>()
  const options = { ...f.options, concurrency: 1, runTimeoutMs: 10000 }
  let turns = 0
  f.deps.harness = {
    async run({ signal }) {
      turns += 1
      if (turns === 1) {
        firstStarted.resolve(signal)
        await release.promise
      } else {
        secondStarted.resolve(signal)
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve()
            return
          }
          signal.addEventListener('abort', () => resolve(), { once: true })
        })
      }
      signal.throwIfAborted()
      return { text: 'answer' }
    },
  }
  const claim = f.deps.claim
  f.deps.claim = async (input) => {
    if (f.accepted.length === 2) {
      f.controller.abort()
      return null
    }
    return await claim(input)
  }
  const worker = runWorker(f.deps, options)
  const timeout = Promise.withResolvers<never>()
  const watchdog = setTimeout(
    () => timeout.reject(new Error('Worker did not enter the expected turn')),
    500,
  )
  try {
    const firstSignal = await Promise.race([firstStarted.promise, timeout.promise])
    options.runTimeoutMs = 20
    expect(firstSignal.aborted).toBe(false)
    release.resolve()
    const secondSignal = await Promise.race([secondStarted.promise, timeout.promise])
    await Bun.sleep(75)
    expect(secondSignal.aborted).toBe(true)
  } finally {
    clearTimeout(watchdog)
    f.controller.abort()
    release.resolve()
    await worker
  }
  expect(f.completed).toEqual(['run-0'])
  expect(f.failed).toEqual(['run-1'])
  expect(f.interrupted).toEqual([])
}, 1000)

test('a claim returning after shutdown is settled without inference', async () => {
  const f = fixture()
  const gate = Promise.withResolvers<void>()
  const claiming = Promise.withResolvers<void>()
  const claim = f.deps.claim
  f.deps.claim = async (options) => {
    claiming.resolve()
    await gate.promise
    return await claim(options)
  }
  const worker = runWorker(f.deps, f.options)
  try {
    await claiming.promise
    f.controller.abort()
  } finally {
    gate.resolve()
    f.release.resolve()
    await worker
  }
  expect(f.accepted).toEqual(['run-0'])
  expect(f.peak()).toBe(0)
  expect(f.completed).toEqual([])
  expect(f.interrupted).toEqual(['run-0'])
})

test('a claimed total deadline aborts inference even with a longer local timeout', async () => {
  const f = fixture()
  const started = Promise.withResolvers<AbortSignal>()
  f.options.concurrency = 1
  const claim = f.deps.claim
  f.deps.claim = async (options) => {
    if (f.accepted.length === 1) {
      f.controller.abort()
      return null
    }
    const lease = await claim(options)
    return lease && { ...lease, deadlineAt: new Date(Date.now() + 30) }
  }
  f.deps.harness = {
    async run({ signal }) {
      started.resolve(signal)
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', () => resolve(), { once: true })
      })
      signal.throwIfAborted()
      return { text: 'must not complete' }
    },
  }
  const worker = runWorker(f.deps, { ...f.options, runTimeoutMs: 60000 })
  try {
    const signal = await started.promise
    await worker
    expect(signal.aborted).toBe(true)
    expect(f.completed).toEqual([])
    expect(f.failed).toEqual(['run-0'])
    expect(f.interrupted).toEqual([])
  } finally {
    f.controller.abort()
    f.release.resolve()
    await worker
  }
}, 1000)
