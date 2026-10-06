import { expect, test } from 'bun:test'
import { runWorker } from './run-loop'
import type {
  AgentHarness,
  ExecutionLease,
  ExecutionWrites,
  SandboxSessionPort,
} from './execute-run'

function controlledHarness() {
  const release = Promise.withResolvers<void>()
  const saturated = Promise.withResolvers<void>()
  let active = 0
  let peak = 0
  const harness: AgentHarness = {
    async turn({ signal }) {
      active += 1
      peak = Math.max(peak, active)
      if (active === 2) saturated.resolve()
      await release.promise
      active -= 1
      signal.throwIfAborted()
      return { text: 'answer', history: [] }
    },
  }
  return { harness, release, saturated, peak: () => peak }
}

function recordingWrites() {
  const completed: string[] = []
  const interrupted: string[] = []
  const writes: ExecutionWrites = {
    saveSandbox: async () => true,
    quarantine: async () => {},
    renew: async () => 'renewed',
    appendText: async () => true,
    complete: async (lease) => {
      completed.push(lease.runID)
      return true
    },
    fail: async (lease) => {
      interrupted.push(lease.runID)
      return true
    },
    cancel: async () => true,
  }
  return { writes, completed, interrupted }
}

function queuedClaims() {
  const leases: ExecutionLease[] = Array.from({ length: 3 }, (_, index) => ({
    runID: `run-${index}`,
    threadID: `thread-${index}`,
    commandID: `command-${index}`,
    messageID: `user-${index}`,
    text: 'hello',
    fence: 1,
    ownerID: 'worker',
    history: [],
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
  const { writes, completed, interrupted } = recordingWrites()
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
