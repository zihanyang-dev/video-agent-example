import { expect, test } from 'bun:test'
import { createExecuteRun } from './execute-run'
import type { ExecutionDependencies } from './ports/execution'
import { createMemorySandbox } from '../../../../tests/fixtures/sandbox'
import type { ExecutionStore } from './ports/execution-store'
import type { Harness, HarnessInput } from './ports/harness'

const run = { turnID: 'run', threadID: 'thread', owner: 'worker', message: 'Make a video' }
type Completion = Parameters<ExecutionStore['complete']>[1]

const fixture = () => {
  const saved: Completion[] = []
  const controls = { cancelled: false, messages: [] }
  const sandbox = createMemorySandbox()

  const harness: Harness = {
    run: async () => {},
    steer: async () => {},
    flush: async () => {},
    interrupt: async () => {},
    entries: () => ['checkpoint'],
    dispose: () => {},
  }

  const store: ExecutionStore = {
    accept: async () => {},
    stop: async () => {},
    claim: async () => null,
    renew: async () => true,
    controls: async () => controls,
    delivered: async () => {},
    seal: async () => {},
    checkpoint: async () => ({ entries: [], workspace: null }),
    append: async () => {},
    complete: async (_run, completion) => {
      saved.push(completion)
    },
    expire: async () => {},
  }

  const dependencies: ExecutionDependencies = {
    store,
    startHarness: async () => harness,
    rentSandbox: async () => sandbox,
    workspace: {
      restore: async () => {},
      skills: async () => {},
      save: async () => 'immutable/workspace/',
      publish: async () => 'immutable/output.mp4',
    },
    model: {
      id: 'test',
      baseUrl: 'http://model',
      apiKey: 'test',
      contextWindow: 1000,
      maxTokens: 100,
    },
    skills: [],
    systemPrompt: '',
    sandboxImage: 'test',
    sandboxNetwork: 'test',
    pollMs: 1,
    sandboxEnv: async () => ({}),
  }

  return { dependencies, controls, harness, sandbox, saved }
}

test('success commits the checkpoint and immutable workspace together', async () => {
  const { dependencies, saved } = fixture()

  await createExecuteRun(dependencies)(run)

  expect(saved).toEqual([
    {
      outcome: 'succeeded',
      reason: null,
      checkpoint: { entries: ['checkpoint'], workspace: 'immutable/workspace/' },
    },
  ])
})

test('model failure keeps partial progress and never reports success', async () => {
  const { dependencies, harness, saved } = fixture()
  harness.run = async () => {
    throw new Error('model disconnected')
  }

  await createExecuteRun(dependencies)(run)

  expect(saved[0]).toMatchObject({
    outcome: 'failed',
    reason: 'model disconnected',
    checkpoint: { entries: ['checkpoint'] },
  })
})

test('workspace failure preserves the last committed checkpoint', async () => {
  const { dependencies, saved } = fixture()
  dependencies.workspace.save = async () => {
    throw new Error('objects unavailable')
  }

  await createExecuteRun(dependencies)(run)

  expect(saved[0]).toEqual({
    outcome: 'failed',
    reason: 'objects unavailable',
    checkpoint: { entries: [], workspace: null },
  })
})

test('artifact upload failure prevents a successful completion', async () => {
  const { dependencies, saved, harness } = fixture()
  dependencies.workspace.publish = async () => {
    throw new Error('upload failed')
  }
  dependencies.startHarness = async (input: HarnessInput) => ({
    ...harness,
    run: async () => {
      input.onObservation({
        kind: 'artifact',
        messageID: 'video',
        path: 'final.mp4',
        role: 'final',
      })
    },
  })

  await createExecuteRun(dependencies)(run)

  expect(saved[0]?.outcome).toBe('failed')
  expect(saved[0]?.reason).toBe('upload failed')
})

test('a cancelled run does not start a model or allocate a sandbox', async () => {
  const { dependencies, controls, saved } = fixture()
  controls.cancelled = true
  dependencies.rentSandbox = async () => {
    throw new Error('must not allocate')
  }

  await createExecuteRun(dependencies)(run)

  expect(saved[0]?.outcome).toBe('cancelled')
})

test('preparation failure becomes a durable failure and releases its sandbox', async () => {
  const { dependencies, sandbox, saved } = fixture()
  let released = false
  dependencies.workspace.restore = async () => {
    throw new Error('restore failed')
  }
  sandbox.destroy = async () => {
    released = true
  }

  await createExecuteRun(dependencies)(run)
  expect(saved[0]?.reason).toBe('restore failed')
  expect(released).toBe(true)
})

test('stop interrupts a long flush as well as the initial prompt', async () => {
  const { dependencies, harness, controls, saved } = fixture()
  const flushed = Promise.withResolvers<void>()
  harness.flush = async () => {
    controls.cancelled = true
    await flushed.promise
  }
  harness.interrupt = async () => {
    flushed.resolve()
  }

  await createExecuteRun(dependencies)(run)

  expect(saved[0]?.outcome).toBe('cancelled')
})

test('a requested stop remains cancellation when the model rejects its aborted prompt', async () => {
  const { dependencies, harness, controls, saved } = fixture()
  const aborted = Promise.withResolvers<void>()
  harness.run = async () => {
    controls.cancelled = true
    await aborted.promise
  }
  harness.interrupt = async () => {
    aborted.reject(new Error('request aborted'))
  }

  await createExecuteRun(dependencies)(run)

  expect(saved[0]?.outcome).toBe('cancelled')
  expect(saved[0]?.reason).toBeNull()
})

test('cancellation does not hide a failure to persist its workspace', async () => {
  const { dependencies, harness, controls, saved } = fixture()
  harness.run = async () => {
    controls.cancelled = true
  }
  dependencies.workspace.save = async () => {
    throw new Error('workspace unavailable')
  }

  await createExecuteRun(dependencies)(run)

  expect(saved[0]?.outcome).toBe('failed')
  expect(saved[0]?.checkpoint).toEqual({ entries: [], workspace: null })
})

test('losing ownership during preparation prevents a new model request', async () => {
  const { dependencies, harness, saved } = fixture()
  let requested = false
  dependencies.store.renew = async () => false
  harness.run = async () => {
    requested = true
  }

  await createExecuteRun(dependencies)(run)
  expect(requested).toBe(false)

  expect(saved[0]?.outcome).toBe('failed')
})
