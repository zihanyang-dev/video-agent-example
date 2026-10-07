import { expect, test } from 'bun:test'
import { createPiHarness } from '../harness/pi'
import { assignFileTools } from '../harness/files'
import { sha256, type ObjectStore } from '@vid/object-storage'
import type { AssetReference } from '@vid/contract/execution'
import { executeRun } from './execute-run'
import type { AgentHarness, ExecutionLease, ExecutionWrites, SandboxSessionPort } from './contract'

function deferred<T>() {
  return Promise.withResolvers<T>()
}

const lease: ExecutionLease = {
  runID: 'run',
  threadID: 'thread',
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
      expect(owned).toMatchObject({
        runID: lease.runID,
        threadID: lease.threadID,
        ownerID: lease.ownerID,
        fence: lease.fence,
      })
      expect(leaseMs).toBe(1000)
      return 'renewed'
    },
    appendText: async (_owned, delta) => {
      events.push({ delta })
      return true
    },
    complete: async (_owned, input) => {
      events.push(input)
      return 'completed'
    },
    fail: async (_owned, reason) => {
      events.push({ reason })
      return 'failed'
    },
    cancel: async () => {
      events.push('cancelled')
      return 'cancelled'
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

    readBytes: async () => new Uint8Array(),
    writeBytes: async () => {},
    execute: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    read: async () => '',
    write: async () => {},
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
  const workspaces = new Map<string, SandboxSessionPort>()
  f.sandbox.read = async () => 'assigned workspace contents'
  workspaces.set(lease.runID, f.sandbox)
  f.deps.openSandbox = async (owned, signal) => {
    signal.throwIfAborted()
    const workspace = workspaces.get(owned.runID)
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
    const expected = status === 'lost' ? 'lost' : status === 'cancel' ? 'cancelled' : 'failed'
    expect(await run).toBe(expected)
    const terminal =
      status === 'lost'
        ? []
        : status === 'cancel'
          ? ['cancelled']
          : [
              {
                reason: status === 'shutdown' ? 'interrupted' : 'execution-error',
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

for (const failure of ['close', 'append', 'append-lost', 'turn', 'open'] as const) {
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
    const terminal = failure === 'append-lost' ? [] : [{ reason: 'execution-error' }]
    expect(
      f.events.filter(
        (event) =>
          event !== 'closed' && !(typeof event === 'object' && event !== null && 'delta' in event),
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
  f.deps.writes.complete = async () => {
    f.events.push('cancelled')
    return 'cancelled'
  }
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
  expect(await run.catch((error: unknown) => error)).toEqual(new Error('commit outcome unknown'))
  expect(attempts).toBe(1)
  expect(f.events).toEqual(['closed'])
})

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
  f.sandbox.execute = async () => {
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
  test(`${outcome} does not erase bytes written through the assigned in-memory file port (not native resume proof)`, async () => {
    const f = fixture()
    const files = new Map<string, string>()
    f.sandbox.write = async ({ path, content }) => {
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
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true })
        if (signal.aborted) resolve()
      })
      signal.throwIfAborted()
      return { text: '', history: [] }
    }
    expect(await executeRun(lease, f.deps, f.options)).toBe(
      outcome === 'cancel' ? 'cancelled' : 'failed',
    )
    expect(files.get('/home/user/arbitrary-place/notes')).toBe('persistent')
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
    f.sandbox.readBytes = async () => bytes
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
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true })
          if (signal.aborted) resolve()
        })
      }
      signal.throwIfAborted()
      return { text: 'delivered', history: ['private'] }
    }
    expect(await executeRun(lease, deps, f.options)).toBe(
      terminal === 'complete' ? 'completed' : terminal === 'cancel' ? 'cancelled' : 'failed',
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
    expect(f.events).toEqual(['closed', ...(authority === 'cancel' ? ['cancelled'] : [])])
  })
}

test('terminal and quarantine failures retain both causes after cleanup without retry', async () => {
  const f = fixture()
  const terminal = new Error('terminal COMMIT acknowledgement lost')
  const quarantine = new Error('quarantine COMMIT acknowledgement lost')
  let attempts = 0
  f.deps.writes.complete = async () => {
    attempts++
    throw terminal
  }
  f.deps.writes.quarantine = async () => {
    expect(f.events).toEqual(['closed'])
    throw quarantine
  }
  const run = executeRun(lease, f.deps, f.options)
  await f.started.promise
  f.end.resolve({ text: '', history: [] })
  const failure = await run.catch((cause: unknown) => cause)
  expect(failure).toBeInstanceOf(AggregateError)
  if (!(failure instanceof AggregateError)) throw new Error('Expected both failures')
  expect(failure.errors).toEqual([terminal, quarantine])
  expect(attempts).toBe(1)
})

test('coalesces 10000 synchronous deltas behind the actual append gate and ignores empty fragments', async () => {
  const f = fixture()
  const writing = deferred<void>()
  const release = deferred<void>()
  const deltas: string[] = []
  f.deps.writes.appendText = async (_lease, delta) => {
    deltas.push(delta)
    if (deltas.length === 1) {
      writing.resolve()
      await release.promise
    }
    return true
  }
  const run = executeRun(lease, f.deps, f.options)
  const input = await f.started.promise
  input.onText('first:')
  await writing.promise
  for (let i = 0; i < 10000; i++) {
    input.onText('')
    input.onText(String(i % 10))
  }
  f.end.resolve({ text: 'first:' + '0123456789'.repeat(1000), history: [] })
  try {
    expect(deltas).toEqual(['first:'])
  } finally {
    release.resolve()
  }
  expect(await run).toBe('completed')
  expect(deltas).toEqual(['first:', '0123456789'.repeat(1000)])
  expect(f.events.at(-1)).toEqual({ text: deltas.join(''), history: [] })
})

test('pending UTF8 overflow aborts synchronously, discards unsent content and joins the issued append', async () => {
  const f = fixture()
  const writing = deferred<void>()
  const release = deferred<void>()
  const closed = deferred<void>()
  const deltas: string[] = []
  f.sandbox.close = async () => {
    closed.resolve()
    f.events.push('closed')
  }
  f.deps.writes.appendText = async (_lease, delta) => {
    deltas.push(delta)
    writing.resolve()
    await release.promise
    f.events.push('append-settled')
    return true
  }
  const run = executeRun(lease, f.deps, f.options)
  const input = await f.started.promise
  input.onText('issued')
  await writing.promise
  // 65536 UTF8 bytes fit; the next byte must stop spending before another inference.
  input.onText('😀'.repeat(16384))
  expect(input.signal.aborted).toBe(false)
  input.onText('x')
  const stopped = input.signal.aborted
  input.onText('must discard')
  f.end.resolve({ text: 'discard', history: ['PRIVATE HISTORY'] })
  await closed.promise
  try {
    expect(stopped).toBe(true)
    expect(f.events).toEqual(['closed'])
    expect(deltas).toEqual(['issued'])
  } finally {
    release.resolve()
  }
  expect(await run).toBe('failed')
  expect(deltas).toEqual(['issued'])
  expect(f.events).toEqual(['closed', 'append-settled', { reason: 'execution-error' }])
})

for (const returned of [false, true]) {
  test(`whole-turn UTF8 budget rejects ${returned ? 'unstreamed return' : 'already-drained fragments'} without terminal replay`, async () => {
    const f = fixture()
    let turns = 0
    let stoppedAtLimit = false
    let stoppedAfterLimit = false
    f.deps.harness.turn = async (input) => {
      turns++
      if (returned) return { text: '😀'.repeat(262145), history: [] }
      // Drain each fragment so the pending quota cannot explain this failure.
      for (let i = 0; i < 16; i++) {
        input.onText('😀'.repeat(16384))
        await Promise.resolve()
        await Promise.resolve()
      }
      stoppedAtLimit = input.signal.aborted
      input.onText('x')
      stoppedAfterLimit = input.signal.aborted
      input.signal.throwIfAborted()
      return { text: '', history: [] }
    }
    expect(await executeRun(lease, f.deps, f.options)).toBe('failed')
    expect(turns).toBe(1)
    if (!returned) {
      expect(stoppedAtLimit).toBe(false)
      expect(stoppedAfterLimit).toBe(true)
    }
    expect(f.events.at(-1)).toEqual({ reason: 'execution-error' })
    expect(
      f.events.some((event) => typeof event === 'object' && event !== null && 'history' in event),
    ).toBe(false)
  })
}

for (const stage of [
  'renew-sql',
  'turn',
  'append',
  'pause',
  'terminal-complete',
  'terminal-fail',
  'terminal-cancel',
  'quarantine',
] as const) {
  test(`private ${stage} diagnosis contains only safe identity and classification`, async () => {
    const f = fixture()
    const canary = 'PRIVATE key=secret prompt=hidden body=tool history=private'
    const failure = new Error(canary, { cause: { private: canary } })
    const records: unknown[][] = []
    const original = console.error
    console.error = (...args: unknown[]) => {
      records.push(args)
    }
    if (stage === 'renew-sql')
      f.deps.writes.renew = async () => {
        throw failure
      }
    f.deps.harness.turn = async (input) => {
      if (['turn', 'quarantine'].includes(stage)) throw failure
      if (stage === 'terminal-fail') f.shutdown.abort()
      if (stage === 'append') input.onText('public text')
      return { text: '', history: [] }
    }
    if (stage === 'append')
      f.deps.writes.appendText = async () => {
        throw failure
      }
    if (stage === 'pause')
      f.sandbox.close = async () => {
        throw failure
      }
    if (stage === 'terminal-complete')
      f.deps.writes.complete = async () => {
        throw failure
      }
    if (stage === 'terminal-fail')
      f.deps.writes.fail = async () => {
        throw failure
      }
    if (stage === 'terminal-cancel') {
      f.deps.writes.renew = async () => 'cancel'
      f.deps.writes.cancel = async () => {
        throw failure
      }
    }
    if (stage === 'quarantine')
      f.deps.writes.quarantine = async () => {
        throw failure
      }
    try {
      await executeRun(lease, f.deps, f.options).catch(() => {})
      expect(records).toContainEqual([
        { runID: 'run', fence: 7, stage, classification: 'unknown-outcome' },
      ])
      expect(JSON.stringify(records)).not.toContain(canary)
      for (const record of records)
        expect(Object.keys(record[0] as object).sort()).toEqual([
          'classification',
          'fence',
          'runID',
          'stage',
        ])
      expect(JSON.stringify(f.events)).not.toContain(canary)
    } finally {
      console.error = original
    }
  })
}

for (const mode of ['coalesce', 'overflow', 'provider-failure'] as const) {
  test(`native Pi ${mode} settles its callback, drain and pause with safe diagnostics and no inference replay`, async () => {
    const f = fixture()
    const canary = 'PRIVATE_NATIVE_KEY_BODY_PROMPT_HISTORY_TOOL'
    const writing = deferred<void>()
    const release = deferred<void>()
    const produced = deferred<void>()
    const paused = deferred<void>()
    const pause = deferred<void>()
    const deltas: string[] = []
    const records: unknown[][] = []
    let requests = 0
    let fragments = 0
    let appendSettled = false
    let turnSettled = false
    let terminalAttempts = 0
    f.options.pollMs = 60_000
    f.deps.writes.renew = async () => 'renewed'
    f.deps.writes.appendText = async (_lease, delta) => {
      deltas.push(delta)
      writing.resolve()
      await release.promise
      appendSettled = true
      return true
    }
    f.sandbox.close = async () => {
      paused.resolve()
      await pause.promise
      f.events.push('closed')
    }
    const complete = f.deps.writes.complete
    f.deps.writes.complete = async (owned, product) => {
      terminalAttempts++
      expect(turnSettled).toBe(true)
      expect(appendSettled).toBe(true)
      return await complete(owned, product)
    }
    const frame = (delta: unknown, finish_reason: string | null = null) =>
      `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture-model', choices: [{ index: 0, delta, finish_reason }] })}\n\n`
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() {
        requests++
        if (mode === 'provider-failure')
          return Response.json({ error: { message: canary } }, { status: 500 })
        const encoder = new TextEncoder()
        return new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(
                encoder.encode(
                  frame({
                    role: 'assistant',
                    content: 'first:',
                    reasoning_content: canary,
                  }),
                ),
              )
              // Hold the actual DB-port append before native Pi receives the burst.
              await writing.promise
              const burst =
                mode === 'coalesce'
                  ? Array.from({ length: 10000 }, (_, i) =>
                      frame({ content: String(i % 10) }),
                    ).join('')
                  : frame({ content: '😀'.repeat(16385) }) +
                    frame({
                      tool_calls: [
                        {
                          index: 0,
                          id: 'private-call',
                          type: 'function',
                          function: {
                            name: 'execute',
                            arguments: JSON.stringify({ command: canary }),
                          },
                        },
                      ],
                    })
              controller.enqueue(
                encoder.encode(
                  burst +
                    frame({}, mode === 'coalesce' ? 'stop' : 'tool_calls') +
                    'data: [DONE]\n\n',
                ),
              )
              controller.close()
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        )
      },
    })
    const native = createPiHarness({
      baseURL: `http://127.0.0.1:${server.port}/v1`,
      key: canary,
      modelID: 'fixture-model',
      contextWindow: 16384,
      maxOutputTokens: 512,
      reasoning: true,
      input: ['text'],
      systemPrompt: canary,
    })
    let toolCalls = 0
    f.sandbox.execute = async () => {
      toolCalls++
      return { stdout: canary, stderr: canary, exitCode: 0 }
    }
    f.deps.harness.turn = async (input) => {
      f.started.resolve(input)
      try {
        return await native.turn({
          ...input,
          onText: (delta) => {
            input.onText(delta)
            fragments++
            if (fragments === (mode === 'coalesce' ? 10001 : 2)) produced.resolve()
          },
        })
      } finally {
        turnSettled = true
      }
    }
    const original = console.error
    console.error = (...args: unknown[]) => {
      records.push(args)
    }
    const run = executeRun({ ...lease, history: null }, f.deps, f.options)
    try {
      if (mode !== 'provider-failure') await produced.promise
      await paused.promise
      expect(turnSettled).toBe(true)
      expect(f.events).toEqual([])
      expect(terminalAttempts).toBe(0)
      if (mode !== 'provider-failure') expect(deltas).toEqual(['first:'])
      pause.resolve()
      release.resolve()
      expect(await run).toBe(mode === 'coalesce' ? 'completed' : 'failed')
      expect(requests).toBe(1)
      expect(toolCalls).toBe(0)
      expect(terminalAttempts).toBe(mode === 'coalesce' ? 1 : 0)
      expect(JSON.stringify(records)).not.toContain(canary)
      const publicEvents = f.events.map((event) => {
        if (typeof event === 'object' && event !== null && 'history' in event) {
          const { history: _private, ...publicProduct } = event
          return publicProduct
        }
        return event
      })
      expect(JSON.stringify(publicEvents)).not.toContain(canary)
      if (mode === 'coalesce') {
        expect(deltas).toEqual(['first:', '0123456789'.repeat(1000)])
        expect(f.events.at(-1)).toMatchObject({ text: deltas.join('') })
      } else {
        expect(records).toContainEqual([
          {
            runID: 'run',
            fence: 7,
            stage: mode === 'overflow' ? 'text-budget' : 'turn',
            classification: mode === 'overflow' ? 'text-budget-exceeded' : 'unknown-outcome',
          },
        ])
        expect(deltas).toEqual(mode === 'overflow' ? ['first:'] : [])
      }
    } finally {
      pause.resolve()
      release.resolve()
      await run.catch(() => {})
      console.error = original
      await server.stop(true)
    }
  })
}

for (const authority of ['cancel', 'lost'] as const) {
  test(`${authority} discards a coalesced batch but joins the issued append before terminal`, async () => {
    const f = fixture()
    const writing = deferred<void>()
    const release = deferred<void>()
    const aborted = deferred<void>()
    const closed = deferred<void>()
    let status: 'renewed' | 'cancel' | 'lost' = 'renewed'
    const deltas: string[] = []
    f.deps.writes.renew = async () => status
    f.deps.writes.appendText = async (_lease, delta) => {
      deltas.push(delta)
      writing.resolve()
      await release.promise
      f.events.push('append-settled')
      return true
    }
    f.sandbox.close = async () => {
      f.events.push('closed')
      closed.resolve()
    }
    const run = executeRun(lease, f.deps, f.options)
    const input = await f.started.promise
    input.signal.addEventListener('abort', () => aborted.resolve(), {
      once: true,
    })
    input.onText('issued')
    await writing.promise
    for (let i = 0; i < 10000; i++) input.onText('x')
    status = authority
    await aborted.promise
    input.onText('late')
    f.end.resolve({ text: 'discard', history: [] })
    await closed.promise
    try {
      expect(f.events).toEqual(['closed'])
      expect(deltas).toEqual(['issued'])
    } finally {
      release.resolve()
    }
    expect(await run).toBe(authority === 'cancel' ? 'cancelled' : 'lost')
    expect(deltas).toEqual(['issued'])
    expect(f.events).toEqual([
      'closed',
      'append-settled',
      ...(authority === 'cancel' ? ['cancelled'] : []),
    ])
  })
}

test('65536 small pending fragments fit, empty callbacks spend no quota, and the next byte stops admission', async () => {
  const f = fixture()
  const writing = deferred<void>()
  const release = deferred<void>()
  const deltas: string[] = []
  f.deps.writes.appendText = async (_lease, delta) => {
    deltas.push(delta)
    writing.resolve()
    await release.promise
    return true
  }
  const run = executeRun(lease, f.deps, f.options)
  const input = await f.started.promise
  input.onText('issued')
  await writing.promise
  for (let i = 0; i < 65536; i++) {
    input.onText('')
    input.onText('x')
  }
  const stoppedAtLimit = input.signal.aborted
  for (let i = 0; i < 10000; i++) input.onText('')
  const stoppedAfterEmpty = input.signal.aborted
  input.onText('x')
  const stoppedAfterLimit = input.signal.aborted
  f.end.resolve({ text: 'discard', history: [] })
  release.resolve()
  expect(await run).toBe('failed')
  expect(stoppedAtLimit).toBe(false)
  expect(stoppedAfterEmpty).toBe(false)
  expect(stoppedAfterLimit).toBe(true)
  expect(deltas).toEqual(['issued'])
})

test('whole-turn text admission refuses the next byte after sixteen drained fragments', async () => {
  const f = fixture()
  let receipt = deferred<void>()
  let appendedBytes = 0
  f.deps.writes.appendText = async (_lease, delta) => {
    appendedBytes += Buffer.byteLength(delta)
    receipt.resolve()
    return true
  }
  const run = executeRun(lease, f.deps, f.options)
  const input = await f.started.promise
  for (let index = 0; index < 16; index++) {
    receipt = deferred<void>()
    input.onText('😀'.repeat(16384))
    await receipt.promise
  }
  expect(appendedBytes).toBe(1048576)
  expect(input.signal.aborted).toBe(false)
  input.onText('x')
  expect(input.signal.aborted).toBe(true)
  f.end.resolve({ text: 'Must not become a completed answer', history: [] })
  expect(await run).toBe('failed')
  expect(appendedBytes).toBe(1048576)
  expect(f.events).toEqual(['closed', { reason: 'execution-error' }])
})

test('native Pi inference admission stops spending after sixteen drained batches', async () => {
  const f = fixture()
  f.deps.writes.renew = async () => 'renewed'
  let requests = 0
  let tools = 0
  let appendedBytes = 0
  const canary = 'PRIVATE_NATIVE_TOOL_HISTORY'
  f.sandbox.execute = async () => {
    tools++
    return { stdout: canary, stderr: '', exitCode: 0 }
  }
  f.deps.writes.appendText = async (_lease, delta) => {
    appendedBytes += Buffer.byteLength(delta)
    return true
  }
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      requests++
      if (requests > 17) return Response.json({ error: { message: canary } }, { status: 500 })
      const chunk = (delta: unknown, finish_reason: string | null = null) =>
        `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture-model', choices: [{ index: 0, delta, finish_reason }] })}\n\n`
      return new Response(
        chunk({
          role: 'assistant',
          content: requests <= 16 ? '😀'.repeat(16384) : 'x',
        }) +
          chunk({
            tool_calls: [
              {
                index: 0,
                id: `call-${requests}`,
                type: 'function',
                function: {
                  name: 'execute',
                  arguments: JSON.stringify({ command: canary }),
                },
              },
            ],
          }) +
          chunk({}, 'tool_calls') +
          'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      )
    },
  })
  f.deps.harness = createPiHarness({
    baseURL: `http://127.0.0.1:${server.port}/v1`,
    key: canary,
    modelID: 'fixture-model',
    contextWindow: 16384,
    maxOutputTokens: 512,
    reasoning: false,
    input: ['text'],
    systemPrompt: canary,
  })
  try {
    expect(await executeRun({ ...lease, history: null }, f.deps, f.options)).toBe('failed')
    expect(appendedBytes).toBe(1048576)
    expect(requests).toBe(16)
    expect(tools).toBe(16)
    expect(f.events).toEqual(['closed', { reason: 'execution-error' }])
    expect(JSON.stringify(f.events)).not.toContain(canary)
  } finally {
    await server.stop(true)
  }
})

test('readonly transport failure is an ordinary tool error without VM quarantine', async () => {
  const f = fixture()
  f.sandbox.read = async () => {
    throw new Error('Readonly transport unavailable')
  }
  f.deps.harness.turn = async (input) => {
    const failure = await input.tools
      .read({ path: '/input', signal: input.signal })
      .catch((error: unknown) => error)
    expect(failure).toEqual(new Error('Readonly transport unavailable'))
    expect(input.signal.aborted).toBe(false)
    return { text: 'Read unavailable', history: [] }
  }
  expect(await executeRun(lease, f.deps, f.options)).toBe('completed')
  expect(f.events).not.toContainEqual({ reason: 'execution-error' })
})

test('history size rejection fails independently without quarantining a settled VM', async () => {
  const f = fixture()
  const { admitPiHistory } = await import('../harness/pi-history')
  f.deps.harness.turn = async () => {
    admitPiHistory({ private: 'x'.repeat(4 * 1024 * 1024) })
    return { text: '', history: [] }
  }
  let quarantines = 0
  f.deps.writes.quarantine = async () => {
    quarantines++
  }
  expect(await executeRun(lease, f.deps, f.options)).toBe('failed')
  expect(quarantines).toBe(0)
  expect(f.events).toEqual(['closed', { reason: 'execution-error' }])
})

test('run deadline aborts spending while SQL heartbeat retains separate cleanup authority', async () => {
  const f = fixture()
  f.deps.harness.turn = async ({ signal }) => {
    await new Promise<void>((resolve) =>
      signal.addEventListener('abort', () => resolve(), { once: true }),
    )
    signal.throwIfAborted()
    return { text: '', history: [] }
  }
  expect(await executeRun(lease, f.deps, { ...f.options, runTimeoutMs: 10 })).toBe('failed')
  expect(f.events).toEqual(['closed', { reason: 'execution-error' }])
})
