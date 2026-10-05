import { expect, test } from 'bun:test'
import { assignFileTools } from './harness/files'
import { sha256, type ObjectStore } from '@vid/object-storage'
import type { AssetReference } from '@vid/contract/execution'
import {
  executeRun,
  type AgentHarness,
  type ExecutionLease,
  type ExecutionWrites,
  type SandboxSessionPort,
} from './execute-run'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const lease: ExecutionLease = {
  runID: 'run',
  threadID: 'thread',
  commandID: 'command',
  messageID: 'user',
  text: 'hello',
  fence: 7,
  ownerID: 'worker',
  history: { private: 'before' },
}
function recordingWrites(events: unknown[]): ExecutionWrites {
  return {
    saveSandbox: async () => true,
    quarantine: async (_lease, reason) => {
      if (reason === 'execution-error') events.push({ reason })
    },
    renew: async (owned, leaseMs) => {
      expect(owned).toBe(lease)
      expect(leaseMs).toBe(1000)
      return 'renewed'
    },
    appendText: async (_owned, delta) => {
      events.push({ delta })
      return true
    },
    complete: async (_owned, input) => {
      events.push(input)
      return true
    },
    fail: async (_owned, reason) => {
      events.push({ reason })
      return true
    },
    cancel: async () => {
      events.push('cancelled')
      return true
    },
  }
}

function fixture() {
  const events: unknown[] = []
  const shutdown = new AbortController()
  const started = deferred<Parameters<AgentHarness['turn']>[0]>()
  const end = deferred<Awaited<ReturnType<AgentHarness['turn']>>>()
  const sandbox: SandboxSessionPort = {
    nativeRef: { provider: 'e2b', id: 'fixture-native' },
    renewTimeout: async () => {},
    files: {
      readBytes: async () => new Uint8Array(),
      writeBytes: async () => {},
    },
    tools: {
      execute: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      read: async () => '',
      write: async () => {},
    },
    close: async () => {
      events.push('closed')
    },
  }
  const writes = recordingWrites(events)
  const harness: AgentHarness = {
    turn: async (input) => {
      started.resolve(input)
      return await end.promise
    },
  }
  const deps = {
    writes,
    harness,
    openSandbox: async (_lease: ExecutionLease, signal: AbortSignal) => {
      signal.throwIfAborted()
      return sandbox
    },
  }
  const options = {
    leaseMs: 1000,
    pollMs: 5,
    signal: shutdown.signal,
  }
  return { events, shutdown, started, end, sandbox, deps, options }
}

test('allocates the lease-assigned workspace without passing provider configuration through execution', async () => {
  const f = fixture()
  const workspaces = new Map<unknown, SandboxSessionPort>()
  f.sandbox.tools.read = async () => 'assigned workspace contents'
  workspaces.set(lease, f.sandbox)
  f.deps.openSandbox = async (runID, signal) => {
    signal.throwIfAborted()
    const workspace = workspaces.get(runID)
    if (!workspace) throw new Error('Workspace was not assigned to this run')
    return workspace
  }
  f.deps.harness.turn = async (input) => ({
    text: await input.tools.read({ path: '/input.txt', signal: input.signal }),
    history: { private: 'after' },
  })
  expect(await executeRun(lease, f.deps, f.options)).toBe('completed')
  expect(f.events.at(-1)).toEqual({
    text: 'assigned workspace contents',
    history: { private: 'after' },
  })
})

test('drains ordered text and owned cleanup before committing complete private history', async () => {
  const f = fixture()
  const first = deferred<void>()
  const writing = deferred<void>()
  f.deps.writes.appendText = async (_lease, delta) => {
    if (delta === 'one') {
      writing.resolve()
      await first.promise
    }
    f.events.push({ delta })
    return true
  }
  const closing = deferred<void>()
  const closed = deferred<void>()
  f.sandbox.close = async () => {
    closing.resolve()
    await closed.promise
    f.events.push('closed')
  }
  const run = executeRun(lease, f.deps, f.options)
  const input = await f.started.promise
  expect(input.history).toEqual({ private: 'before' })
  input.onText('one')
  input.onText('two')
  await writing.promise
  f.end.resolve({ text: 'onetwo', history: { private: 'after' } })
  await closing.promise
  expect(f.events).toEqual([])
  closed.resolve()
  first.resolve()
  expect(await run).toBe('completed')
  expect(f.events.filter((event) => event !== 'closed')).toEqual([
    { delta: 'one' },
    { delta: 'two' },
    { text: 'onetwo', history: { private: 'after' } },
  ])
  expect(f.events.indexOf('closed')).toBeLessThan(f.events.length - 1)
  input.onText('late')
  expect(f.events).toHaveLength(4)
})

for (const status of ['cancel', 'lost', 'error', 'shutdown'] as const) {
  test(`${status} aborts turn, discards queued text and awaits turn settlement before terminal`, async () => {
    const f = fixture()
    const poll = deferred<void>()
    let renewals = 0
    f.deps.writes.renew = async () => {
      renewals++
      if (renewals === 1) return 'renewed'
      await poll.promise
      if (status === 'error') throw new Error('database unavailable')
      return status === 'cancel' ? 'cancel' : 'lost'
    }
    const run = executeRun(lease, f.deps, f.options)
    const input = await f.started.promise
    const aborted = deferred<void>()
    input.signal.addEventListener(
      'abort',
      () => {
        aborted.resolve()
      },
      { once: true },
    )
    if (status === 'shutdown') f.shutdown.abort()
    poll.resolve()
    await aborted.promise
    input.onText('late')
    expect(f.events).toEqual([])
    f.end.resolve({ text: 'late', history: { private: 'discard' } })
    const expected =
      status === 'lost' ? 'lost' : status === 'cancel' ? 'cancelled' : 'failed'
    expect(await run).toBe(expected)
    const terminal =
      status === 'lost'
        ? []
        : status === 'cancel'
          ? ['cancelled']
          : [
              {
                reason:
                  status === 'shutdown' ? 'interrupted' : 'execution-error',
              },
            ]
    expect(f.events).toEqual(['closed', ...terminal])
  })
}

test('cancellation during allocation aborts opener and awaits its cleanup without starting Pi', async () => {
  const f = fixture()
  const allocating = deferred<AbortSignal>()
  const cleanup = deferred<void>()
  f.deps.openSandbox = async (_options, signal) => {
    allocating.resolve(signal)
    await cleanup.promise
    signal.throwIfAborted()
    return f.sandbox
  }
  let renewals = 0
  f.deps.writes.renew = async () => (++renewals === 1 ? 'renewed' : 'cancel')
  const run = executeRun(lease, f.deps, f.options)
  const signal = await allocating.promise
  const aborted = deferred<void>()
  signal.addEventListener(
    'abort',
    () => {
      aborted.resolve()
    },
    { once: true },
  )
  await aborted.promise
  expect(f.events).toEqual([])
  cleanup.resolve()
  expect(await run).toBe('cancelled')
  expect(f.events).toEqual(['cancelled'])
})

for (const failure of [
  'close',
  'append',
  'append-lost',
  'turn',
  'open',
] as const) {
  test(`${failure} failure never commits history or replays a paid turn`, async () => {
    const f = fixture()
    if (failure === 'close')
      f.sandbox.close = async () => {
        throw new Error('delete failed')
      }
    if (failure === 'append')
      f.deps.writes.appendText = async () => {
        throw new Error('write failed')
      }
    if (failure === 'append-lost') f.deps.writes.appendText = async () => false
    if (failure === 'open')
      f.deps.openSandbox = async () => {
        throw new Error('unknown creation outcome')
      }
    if (failure === 'turn')
      f.deps.harness.turn = async () => {
        throw new Error('unknown inference outcome')
      }
    const run = executeRun(lease, f.deps, f.options)
    if (failure !== 'open' && failure !== 'turn') {
      const input = await f.started.promise
      input.onText('text')
      f.end.resolve({ text: 'text', history: 'must not commit' })
    }
    expect(await run).toBe(failure === 'append-lost' ? 'lost' : 'failed')
    expect(f.events).not.toContainEqual({
      text: 'text',
      history: 'must not commit',
    })
    const terminal =
      failure === 'append-lost' ? [] : [{ reason: 'execution-error' }]
    expect(
      f.events.filter(
        (event) =>
          event !== 'closed' &&
          !(typeof event === 'object' && event !== null && 'delta' in event),
      ),
    ).toEqual(terminal)
  })
}

test('joins an in-flight heartbeat before returning or completing', async () => {
  const f = fixture()
  const renewing = deferred<void>()
  const renewed = deferred<'renewed' | 'lost'>()
  let count = 0
  f.deps.writes.renew = async () => {
    if (++count === 1) return 'renewed'
    renewing.resolve()
    return await renewed.promise
  }
  const run = executeRun(lease, f.deps, f.options)
  await f.started.promise
  await renewing.promise
  f.end.resolve({ text: '', history: 'private' })
  const closing = deferred<void>()
  f.sandbox.close = async () => {
    f.events.push('closed')
    closing.resolve()
  }
  await closing.promise
  expect(f.events).toEqual(['closed'])
  renewed.resolve('lost')
  expect(await run).toBe('lost')
  expect(f.events).toEqual(['closed'])
})

test('allocation cleanup rejection after cancellation is an execution error, not successful cancellation', async () => {
  const f = fixture()
  let count = 0
  f.deps.writes.renew = async () => (++count === 1 ? 'renewed' : 'cancel')
  f.deps.openSandbox = async (_options, signal) => {
    await new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => resolve(), { once: true })
    })
    throw new Error('remote delete failed')
  }
  expect(await executeRun(lease, f.deps, f.options)).toBe('failed')
  expect(f.events).toEqual([{ reason: 'execution-error' }])
})

test('fencing loss discards queued writes and joins the already-started write', async () => {
  const f = fixture()
  const writing = deferred<void>()
  const written = deferred<void>()
  const polled = deferred<void>()
  let count = 0
  f.deps.writes.renew = async () => {
    if (++count === 1) return 'renewed'
    polled.resolve()
    return 'lost'
  }
  f.deps.writes.appendText = async (_owned, delta) => {
    writing.resolve()
    await written.promise
    f.events.push({ delta })
    return true
  }
  const run = executeRun(lease, f.deps, f.options)
  const input = await f.started.promise
  input.onText('in-flight')
  input.onText('discard')
  await writing.promise
  await polled.promise
  f.end.resolve({ text: 'discard', history: 'discard' })
  const closed = deferred<void>()
  f.sandbox.close = async () => {
    f.events.push('closed')
    closed.resolve()
  }
  await closed.promise
  expect(f.events).toEqual(['closed'])
  written.resolve()
  expect(await run).toBe('lost')
  expect(f.events).toEqual(['closed', { delta: 'in-flight' }])
})

for (const status of ['lost', 'cancel'] as const) {
  test(`initial ${status} does not allocate a sandbox or begin a paid turn`, async () => {
    const f = fixture()
    f.deps.writes.renew = async () => status
    f.deps.openSandbox = async () => {
      f.events.push('allocated')
      throw new Error('must not allocate')
    }
    expect(await executeRun(lease, f.deps, f.options)).toBe(
      status === 'lost' ? 'lost' : 'cancelled',
    )
    expect(f.events).toEqual(status === 'lost' ? [] : ['cancelled'])
  })
}

test('an append rejected by cancellation renews authority before choosing cancelled vs lost', async () => {
  const f = fixture()
  let count = 0
  f.deps.writes.renew = async () => (++count === 1 ? 'renewed' : 'cancel')
  f.deps.writes.appendText = async () => false
  const run = executeRun(lease, f.deps, f.options)
  const input = await f.started.promise
  input.onText('rejected')
  f.end.resolve({ text: 'rejected', history: 'discard' })
  expect(await run).toBe('cancelled')
  expect(f.events).toEqual(['closed', 'cancelled'])
})

test('turn abort rejection is awaited and preserves an explicit shutdown interruption', async () => {
  const f = fixture()
  const aborted = deferred<void>()
  const settled = deferred<void>()
  f.deps.harness.turn = async (input) => {
    f.started.resolve(input)
    input.signal.addEventListener('abort', () => aborted.resolve(), {
      once: true,
    })
    await settled.promise
    input.signal.throwIfAborted()
    return { text: '', history: 'unused' }
  }
  const run = executeRun(lease, f.deps, f.options)
  await f.started.promise
  f.shutdown.abort()
  await aborted.promise
  expect(f.events).toEqual([])
  settled.resolve()
  expect(await run).toBe('failed')
  expect(f.events).toEqual(['closed', { reason: 'interrupted' }])
})

test('cancellation racing completion is settled without committing history', async () => {
  const f = fixture()
  let count = 0
  f.deps.writes.renew = async () => (++count === 1 ? 'renewed' : 'cancel')
  f.deps.writes.complete = async () => false
  const run = executeRun(lease, f.deps, f.options)
  await f.started.promise
  f.end.resolve({ text: '', history: 'not committed' })
  expect(await run).toBe('cancelled')
  expect(f.events).toEqual(['closed', 'cancelled'])
})

test('an unknown terminal database outcome is surfaced after cleanup, never retried', async () => {
  const f = fixture()
  let attempts = 0
  f.deps.writes.complete = async () => {
    attempts++
    throw new Error('commit outcome unknown')
  }
  const run = executeRun(lease, f.deps, f.options)
  await f.started.promise
  f.end.resolve({ text: '', history: 'private' })
  expect(await run.catch((error: unknown) => error)).toEqual(
    new Error('commit outcome unknown'),
  )
  expect(attempts).toBe(1)
  expect(f.events).toEqual(['closed'])
})

for (const authority of ['cancel', 'lost', 'renewed'] as const) {
  test(`shutdown terminal rejection reauthorizes ${authority} without retrying a paid turn`, async () => {
    const f = fixture()
    let renewals = 0
    let turns = 0
    let failures = 0
    const turn = f.deps.harness.turn
    f.deps.harness.turn = async (input) => {
      turns++
      return await turn(input)
    }
    f.deps.writes.renew = async () => (++renewals === 1 ? 'renewed' : authority)
    f.deps.writes.fail = async (_lease, reason) => {
      failures++
      f.events.push({ reason })
      return false
    }
    // No heartbeat can observe the terminal race before the failed write.
    f.options.pollMs = 60_000
    const run = executeRun(lease, f.deps, f.options)
    await f.started.promise
    f.shutdown.abort()
    f.end.resolve({ text: '', history: 'must not commit' })
    expect(await run).toBe(authority === 'cancel' ? 'cancelled' : 'lost')
    expect(turns).toBe(1)
    expect(failures).toBe(1)
    expect(renewals).toBe(2)
    expect(f.events).toEqual([
      'closed',
      { reason: 'interrupted' },
      ...(authority === 'cancel' ? ['cancelled'] : []),
    ])
  })
}

test('native identity is fenced durably before inference can spend', async () => {
  const f = fixture()
  let persisted = false
  Object.assign(f.sandbox, { nativeRef: { provider: 'e2b', id: 'native-1' } })
  Object.assign(f.deps.writes, {
    saveSandbox: async () => {
      persisted = true
      return true
    },
  })
  f.deps.harness.turn = async () => {
    expect(persisted).toBe(true)
    return { text: 'done', history: [] }
  }
  expect(await executeRun(lease, f.deps, f.options)).toBe('completed')
  expect(persisted).toBe(true)
})

test('uncertain command outcome aborts spending before Pi can request another inference', async () => {
  const f = fixture()
  let observedAbort = false
  f.sandbox.tools.execute = async () => {
    throw new Error('command ACK lost')
  }
  f.deps.harness.turn = async ({ tools, signal }) => {
    await tools.execute({ command: 'paid-job', signal }).catch(() => {})
    observedAbort = signal.aborted
    signal.throwIfAborted()
    return { text: 'must not infer again', history: [] }
  }
  expect(await executeRun(lease, f.deps, f.options)).toBe('failed')
  expect(observedAbort).toBe(true)
  expect(f.events).toEqual(['closed', { reason: 'execution-error' }])
})

for (const outcome of ['cancel', 'failure'] as const) {
  test(`${outcome} retains environment files for the next known native resume`, async () => {
    const f = fixture()
    const files = new Map<string, string>()
    f.sandbox.tools.write = async ({ path, content }) => {
      files.set(path, content)
    }
    f.deps.harness.turn = async ({ tools, signal }) => {
      await tools.write({
        path: '/home/user/arbitrary-place/notes',
        content: 'persistent',
        signal,
      })
      if (outcome === 'failure') throw new Error('model failed')
      f.deps.writes.renew = async () => 'cancel'
      await Bun.sleep(10)
      signal.throwIfAborted()
      return { text: '', history: [] }
    }
    expect(await executeRun(lease, f.deps, f.options)).toBe(
      outcome === 'cancel' ? 'cancelled' : 'failed',
    )
    expect(files.get('/home/user/arbitrary-place/notes')).toBe('persistent')
  })
}

test('unknown renewal after rejected completion quarantines before returning failed without replay', async () => {
  const f = fixture()
  f.options.pollMs = 60_000
  let turns = 0
  let completions = 0
  let quarantines = 0
  let renewals = 0
  f.deps.harness.turn = async () => {
    turns++
    return { text: 'paid answer', history: ['private'] }
  }
  f.deps.writes.complete = async () => {
    completions++
    return false
  }
  f.deps.writes.renew = async () => {
    if (++renewals === 1) return 'renewed'
    throw new Error('renewal outcome unknown')
  }
  f.deps.writes.quarantine = async (_lease, reason) => {
    quarantines++
    f.events.push({ reason })
  }
  expect(await executeRun(lease, f.deps, f.options)).toBe('failed')
  expect(quarantines).toBe(1)
  expect(turns).toBe(1)
  expect(completions).toBe(1)
  expect(f.events).toEqual(['closed', { reason: 'execution-error' }])
})

for (const terminal of ['complete', 'cancel', 'fail'] as const) {
  test(`recovery observed after rejected ${terminal} settles failed without retrying terminal`, async () => {
    const f = fixture()
    f.options.pollMs = 60_000
    let renewals = 0
    let attempts = 0
    let quarantines = 0
    f.deps.writes.renew = async () => {
      if (++renewals === 1) return terminal === 'cancel' ? 'cancel' : 'renewed'
      return 'recovery-required'
    }
    f.deps.writes[terminal] = async () => {
      attempts++
      return false
    }
    f.deps.writes.quarantine = async (_lease, reason) => {
      quarantines++
      f.events.push({ reason })
    }
    f.deps.harness.turn = async () => {
      if (terminal === 'fail') f.shutdown.abort()
      return { text: 'paid', history: ['discard'] }
    }
    expect(await executeRun(lease, f.deps, f.options)).toBe('failed')
    expect(attempts).toBe(1)
    expect(quarantines).toBe(1)
    expect(f.events).toEqual([
      ...(terminal === 'cancel' ? [] : ['closed']),
      { reason: 'execution-error' },
    ])
  })
}

for (const terminal of ['complete', 'cancel', 'unknown-upload'] as const) {
  test(`${terminal} publishes prepared assets only with a completed private turn`, async () => {
    const f = fixture()
    const bytes = new Uint8Array([1, 2, 3])
    const uploaded = new Map<string, Uint8Array>()
    const objects: ObjectStore = {
      read: async () => bytes,
      put: async (key, content) => {
        uploaded.set(key, content)
        if (terminal === 'unknown-upload') throw new Error('Upload ACK lost')
        return { byteLength: content.byteLength, sha256: sha256(content) }
      },
      close: () => {},
    }
    f.sandbox.files.readBytes = async () => bytes
    const deps = {
      ...f.deps,
      fileTools: assignFileTools(objects, {
        maxBytes: 10,
        maxFiles: 1,
        timeoutMs: 1000,
      }),
    }
    let exported: AssetReference | undefined
    deps.harness.turn = async ({ fileTools, signal }) => {
      if (fileTools === undefined) throw new Error('Missing file authority')
      exported = await fileTools
        .exportFile({
          path: '/chosen',
          name: 'output.bin',
          mimeType: 'application/octet-stream',
          signal,
        })
        .catch(() => undefined)
      if (terminal === 'cancel') {
        f.deps.writes.renew = async () => 'cancel'
        await Bun.sleep(10)
      }
      signal.throwIfAborted()
      return { text: 'delivered', history: ['private'] }
    }
    expect(await executeRun(lease, deps, f.options)).toBe(
      terminal === 'complete'
        ? 'completed'
        : terminal === 'cancel'
          ? 'cancelled'
          : 'failed',
    )
    expect(uploaded.size).toBe(1)
    expect(f.events).toEqual([
      'closed',
      terminal === 'complete'
        ? { text: 'delivered', history: ['private'], assets: [exported] }
        : terminal === 'cancel'
          ? 'cancelled'
          : { reason: 'execution-error' },
    ])
  })
}

for (const authority of ['cancel', 'lost'] as const) {
  test(`rejected sandbox identity reauthorizes ${authority} without beginning inference`, async () => {
    const f = fixture()
    f.options.pollMs = 60_000
    let renewals = 0
    f.deps.writes.renew = async () => (++renewals === 1 ? 'renewed' : authority)
    f.deps.writes.saveSandbox = async () => false
    f.deps.harness.turn = async () => {
      throw new Error('Inference must not start')
    }
    expect(await executeRun(lease, f.deps, f.options)).toBe(
      authority === 'cancel' ? 'cancelled' : 'lost',
    )
    expect(f.events).toEqual([
      'closed',
      ...(authority === 'cancel' ? ['cancelled'] : []),
    ])
  })
}
