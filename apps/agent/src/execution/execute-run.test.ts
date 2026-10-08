import { expect, test } from 'bun:test'
import { executeRun } from './execute-run'
import { sha256, type ObjectStore } from '@vid/object-storage'
import { assignFileTools } from '../harness/files'
import { CapabilityRejectedError } from '../contract'
import type { AssetReference } from '@vid/contract/execution'
import type {
  AgentHarness,
  ExecutionLease,
  ExecutionWrites,
  SandboxSessionPort,
  SandboxFiles,
} from '../contract.ts'

const lease: ExecutionLease = {
  runID: 'run',
  threadID: 'thread',
  text: 'hello',
  fence: 7,
  ownerID: 'worker',
  engine: 'pi',
  nativeSessionID: 'session',
  deadlineAt: new Date(Date.now() + 120000),
  restoring: false,
  restoreWorkspace: false,
}
function fixture() {
  const events: unknown[] = []
  const shutdown = new AbortController()
  const sandbox: SandboxSessionPort = {
    nativeRef: { provider: 'e2b', id: 'fixture' },
    execute: async () => {
      events.push('execute')
      return { stdout: '', stderr: '', exitCode: 0 }
    },
    read: async () => {
      events.push('read')
      return ''
    },
    write: async () => {
      events.push('write')
    },
    readBytes: async () => {
      events.push('readBytes')
      return new Uint8Array()
    },
    writeBytes: async () => {
      events.push('writeBytes')
    },
    close: async () => {
      events.push('closed')
    },
  }
  const writes: ExecutionWrites = {
    beginWorkspaceTransition: async () => true,
    settleWorkspaceTransition: async () => true,
    rejectEffect: async () => true,
    renew: async () => 'renewed',
    saveSandbox: async () => true,
    reserveModel: async () => {
      events.push('model-reserved')
      return 'allowed'
    },
    beginEffect: async () => {
      events.push('effect-recorded')
      return 'allowed'
    },
    checkpoint: async () => {
      events.push('checkpoint')
      return true
    },
    appendText: async (_lease, delta) => {
      events.push({ delta })
      return true
    },
    complete: async (_lease, completion) => {
      events.push(completion)
      return 'completed'
    },
    fail: async (_lease, reason) => {
      events.push({ reason })
      return 'failed'
    },
    cancel: async () => {
      events.push('cancelled')
      return 'cancelled'
    },
    quarantine: async () => {
      events.push('quarantined')
    },
  }
  const harness: AgentHarness = { run: async () => ({ text: 'done' }) }
  const deps = { writes, harness, openSandbox: async () => sandbox }
  const options = { leaseMs: 1000, pollMs: 60000, signal: shutdown.signal }
  return { events, sandbox, writes, deps, options, shutdown }
}

test('fencing loss after cancellation stops renewal and terminal writes but still joins cleanup', async () => {
  const { events, sandbox, writes, deps, options } = fixture()
  const started = Promise.withResolvers<void>()
  const lost = Promise.withResolvers<void>()
  let renewals = 0
  writes.renew = async () => {
    if (++renewals === 1) return 'renewed'
    if (renewals === 2) {
      await started.promise
      return 'cancel'
    }
    lost.resolve()
    return 'lost'
  }
  deps.harness.run = async ({ signal }) => {
    const cancelled = new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => resolve(), { once: true })
    })
    started.resolve()
    await cancelled
    return { text: 'Must not publish after ownership loss' }
  }
  sandbox.close = async () => {
    await lost.promise
    // Keep cleanup owned long enough to detect renewal after observed loss.
    await Bun.sleep(10)
    events.push('closed')
  }
  expect(await executeRun(lease, deps, { ...options, pollMs: 1 })).toBe('lost')
  expect(events).toEqual(['closed'])
  expect(renewals).toBe(3)
})

test('only confirmed local no-IO rejection removes its effect reservation', async () => {
  const f = fixture()
  let effects = 0
  let reservations = 0
  let corrections = 0
  f.writes.beginEffect = async () => {
    effects++
    reservations++
    return 'allowed'
  }
  f.writes.rejectEffect = async () => {
    effects--
    corrections++
    return true
  }
  f.writes.checkpoint = async () => {
    expect(effects).toBe(0)
    return true
  }
  f.sandbox.write = async () => {
    throw new CapabilityRejectedError('Native write admission rejected')
  }
  f.deps.harness.run = async (input) => {
    expect(
      await input.tools
        .write({ path: '/output', content: 'bytes', signal: input.signal })
        .catch((error: unknown) => error),
    ).toBeInstanceOf(CapabilityRejectedError)
    await input.beforeModel()
    return { text: 'Local rejection observed safely.' }
  }
  expect(await executeRun(lease, f.deps, f.options)).toBe('completed')
  expect(reservations).toBe(1)
  expect(corrections).toBe(1)
  expect(effects).toBe(0)
  expect(f.events).not.toContain('quarantined')
})

test('safe model 401 without IO fails without workspace quarantine', async () => {
  const f = fixture()
  const fail = async () => {
    throw new Error('401')
  }
  f.deps.harness.run = fail
  expect(await executeRun(lease, f.deps, f.options)).toBe('failed')
  expect(f.events).toEqual(['closed', { reason: 'execution-error' }])
})

for (const capability of [
  'read',
  'write',
  'execute',
  'readBytes',
  'writeBytes',
  'importFile',
  'exportFile',
] as const) {
  test(`fresh cancellation blocks actual ${capability} entry without unknown-effect quarantine`, async () => {
    const f = fixture()
    let authorized = true
    f.writes.renew = async () => (authorized ? 'renewed' : 'cancel')
    const work = executeRun(
      lease,
      {
        ...f.deps,
        fileTools: (_assignment, files) => ({
          assigned: [],
          prepared: [],
          importFile: async ({ signal }) => {
            authorized = false
            if (capability === 'readBytes') await files.readBytes('/file', signal, 10)
            else await files.writeBytes('/file', new Uint8Array(), signal)
            return { bytes: new Uint8Array(), mimeType: 'text/plain' }
          },
          exportFile: async ({ signal }) => {
            await files.readBytes('/file', signal, 10)
            throw new Error('unexpected PUT')
          },
        }),
        harness: {
          run: async (input) => {
            if (capability !== 'readBytes' && capability !== 'writeBytes') authorized = false
            if (capability === 'readBytes' || capability === 'writeBytes') {
              // Exercise the file port supplied to the assigned file implementation.
              await input.fileTools!.importFile({
                assetID: 'asset',
                path: '/file',
                signal: input.signal,
              })
            } else if (capability === 'importFile')
              await input.fileTools!.importFile({
                assetID: 'asset',
                path: '/file',
                signal: input.signal,
              })
            else if (capability === 'exportFile')
              await input.fileTools!.exportFile({
                path: '/file',
                name: 'file',
                mimeType: 'text/plain',
                signal: input.signal,
              })
            else if (capability === 'execute')
              await input.tools.execute({ command: 'paid-job', signal: input.signal })
            else if (capability === 'read')
              await input.tools.read({ path: '/file', signal: input.signal })
            else await input.tools.write({ path: '/file', content: 'x', signal: input.signal })
            return { text: 'must not complete' }
          },
        },
      },
      f.options,
    )
    expect(await work).toBe('cancelled')
    expect(f.events).toEqual(['closed', 'cancelled'])
  })
}

for (const decision of ['cancel', 'lost', 'limit', 'recovery-required'] as const) {
  test(`persisted model ${decision} fails closed before a provider request`, async () => {
    const f = fixture()
    let requests = 0
    f.writes.reserveModel = async () => decision
    f.deps.harness.run = async (input) => {
      await input.beforeModel()
      requests++
      return { text: 'bad' }
    }
    expect(await executeRun(lease, f.deps, f.options)).toBe(
      decision === 'cancel' ? 'cancelled' : decision === 'lost' ? 'lost' : 'failed',
    )
    expect(requests).toBe(0)
  })
}

test('effect is recorded before a write and checkpoint acknowledges only durable native results', async () => {
  const f = fixture()
  let pending = 0
  f.writes.beginEffect = async () => {
    pending++
    f.events.push('effect-recorded')
    return 'allowed'
  }
  f.writes.checkpoint = async () => {
    pending = 0
    f.events.push('checkpoint')
    return true
  }
  f.deps.harness.run = async (input) => {
    await input.beforeModel()
    await input.tools.write({ path: '/file', content: 'x', signal: input.signal })
    expect(pending).toBe(1)
    f.events.push('native-result-durable')
    await input.checkpoint()
    expect(pending).toBe(0)
    return { text: 'done' }
  }
  expect(await executeRun(lease, f.deps, f.options)).toBe('completed')
  expect(f.events).toEqual([
    'model-reserved',
    'effect-recorded',
    'write',
    'native-result-durable',
    'checkpoint',
    'closed',
    { text: 'done' },
  ])
})

test('unknown dispatched write stops spending and quarantines without clearing effect counter', async () => {
  const f = fixture()
  let pending = 0
  f.writes.beginEffect = async () => {
    pending++
    return 'allowed'
  }
  f.sandbox.write = async () => {
    throw undefined
  }
  f.deps.harness.run = async (input) => {
    await input.tools.write({ path: '/file', content: 'x', signal: input.signal }).catch(() => {})
    await input.beforeModel()
    return { text: 'bad' }
  }
  expect(await executeRun(lease, f.deps, f.options)).toBe('failed')
  expect(pending).toBe(1)
  expect(f.events).toEqual(['closed', 'quarantined', { reason: 'execution-error' }])
})

test('readonly failure itself leaves workspace reusable', async () => {
  const f = fixture()
  f.sandbox.read = async () => {
    throw new Error('read unavailable')
  }
  f.deps.harness.run = async (input) => {
    await input.tools.read({ path: '/file', signal: input.signal }).catch(() => {})
    return { text: 'unavailable' }
  }
  expect(await executeRun(lease, f.deps, f.options)).toBe('completed')
  expect(f.events).toEqual(['closed', { text: 'unavailable' }])
})

test('unknown terminal COMMIT is propagated once without quarantine or retry', async () => {
  const f = fixture()
  let attempts = 0
  const failure = new Error('unknown COMMIT')
  f.writes.complete = async () => {
    attempts++
    throw failure
  }
  expect(await executeRun(lease, f.deps, f.options).catch((error) => error)).toBe(failure)
  expect(attempts).toBe(1)
  expect(f.events).toEqual(['closed'])
})

test('restoration suppresses public deltas and preserves cached completion assets', async () => {
  const f = fixture()
  const assets = [
    {
      assetID: 'cached',
      objectKey: 'allocated-output',
      name: 'cached.txt',
      mimeType: 'text/plain',
      byteLength: 6,
      sha256: sha256(new TextEncoder().encode('cached')),
    },
  ] satisfies AssetReference[]
  f.deps.harness.run = async (input) => {
    input.onText('duplicate')
    return { text: 'canonical', assets }
  }
  expect(
    await executeRun(
      { ...lease, restoring: true },
      {
        ...f.deps,
        fileTools: () => ({
          assigned: [],
          prepared: [],
          importFile: async () => {
            throw new Error('unused')
          },
          exportFile: async () => {
            throw new Error('unused')
          },
        }),
      },
      f.options,
    ),
  ).toBe('completed')
  expect(f.events).toEqual(['closed', { text: 'canonical', assets }])
})

test('original expired deadline prevents allocation and model spending', async () => {
  const f = fixture()
  let allocations = 0
  f.deps.openSandbox = async () => {
    allocations++
    return f.sandbox
  }
  expect(await executeRun({ ...lease, deadlineAt: new Date(0) }, f.deps, f.options)).toBe('failed')
  expect(allocations).toBe(0)
})

test('file export read failure is not an unknown PUT or workspace uncertainty', async () => {
  const f = fixture()
  f.sandbox.readBytes = async () => {
    throw new Error('read failed')
  }
  const deps = {
    ...f.deps,
    fileTools: (_assignment: unknown, files: SandboxFiles) => ({
      assigned: [],
      prepared: [],
      importFile: async () => {
        throw new Error('unused')
      },
      exportFile: async ({ signal }: { signal: AbortSignal }) => {
        await files.readBytes('/file', signal, 10)
        throw new Error('PUT must not start')
      },
    }),
  }
  deps.harness.run = async (input) => {
    await input
      .fileTools!.exportFile({
        path: '/file',
        name: 'file',
        mimeType: 'text/plain',
        signal: input.signal,
      })
      .catch(() => {})
    return { text: 'read failed' }
  }
  expect(await executeRun(lease, deps, f.options)).toBe('completed')
  expect(f.events).toEqual(['closed', { text: 'read failed', assets: [] }])
})

test('issued text and remote close are joined before canonical completion', async () => {
  const f = fixture()
  const write = Promise.withResolvers<void>()
  const close = Promise.withResolvers<void>()
  const closing = Promise.withResolvers<void>()
  f.writes.appendText = async (_lease, delta) => {
    await write.promise
    f.events.push({ delta })
    return true
  }
  f.sandbox.close = async () => {
    closing.resolve()
    await close.promise
    f.events.push('closed')
  }
  f.deps.harness.run = async (input) => {
    input.onText('one')
    input.onText('two')
    return { text: 'onetwo' }
  }
  const run = executeRun(lease, f.deps, f.options)
  await closing.promise
  expect(f.events).toEqual([])
  close.resolve()
  write.resolve()
  expect(await run).toBe('completed')
  expect(f.events.at(-1)).toEqual({ text: 'onetwo' })
  expect(f.events).toContainEqual({ delta: 'one' })
  expect(f.events).toContainEqual({ delta: 'two' })
})

test('primary thrown undefined and pause failure are both preserved', async () => {
  const f = fixture()
  const cleanup = new Error('pause unknown')
  f.deps.harness.run = async () => {
    throw undefined
  }
  f.sandbox.close = async () => {
    throw cleanup
  }
  const failure = await executeRun(lease, f.deps, f.options).catch((error) => error)
  expect(failure).toBeInstanceOf(AggregateError)
  expect((failure as AggregateError).errors).toEqual([undefined, cleanup])
})

test('persisted request budget admits sixteen model calls and never charges a seventeenth', async () => {
  const f = fixture()
  let reserved = 0
  let requests = 0
  f.writes.reserveModel = async () => (reserved === 16 ? 'limit' : (reserved++, 'allowed'))
  f.deps.harness.run = async (input) => {
    for (let index = 0; index < 17; index++) {
      await input.beforeModel()
      requests++
      await input.checkpoint()
    }
    return { text: 'bad' }
  }
  expect(await executeRun(lease, f.deps, f.options)).toBe('failed')
  expect(reserved).toBe(16)
  expect(requests).toBe(16)
  expect(f.events).not.toContain('quarantined')
})

test('pending UTF8 overflow stops synchronously and joins the issued append', async () => {
  const f = fixture()
  const release = Promise.withResolvers<void>()
  const closing = Promise.withResolvers<void>()
  const deltas: string[] = []
  f.writes.appendText = async (_lease, delta) => {
    deltas.push(delta)
    await release.promise
    return true
  }
  f.sandbox.close = async () => {
    closing.resolve()
    f.events.push('closed')
  }
  f.deps.harness.run = async (input) => {
    input.onText('issued')
    input.onText('😀'.repeat(16384))
    expect(input.signal.aborted).toBe(false)
    input.onText('x')
    expect(input.signal.aborted).toBe(true)
    return { text: 'bad' }
  }
  const run = executeRun(lease, f.deps, f.options)
  await closing.promise
  expect(f.events).toEqual(['closed'])
  release.resolve()
  expect(await run).toBe('failed')
  expect(deltas).toEqual(['issued'])
  expect(f.events).not.toContain('quarantined')
})

test('legacy timeout may clamp but cannot reset the original request deadline', async () => {
  const f = fixture()
  f.deps.harness.run = async ({ signal }) => {
    await new Promise<void>((resolve) =>
      signal.addEventListener('abort', () => resolve(), { once: true }),
    )
    signal.throwIfAborted()
    return { text: 'bad' }
  }
  expect(await executeRun(lease, f.deps, { ...f.options, runTimeoutMs: 5 })).toBe('failed')
  expect(f.events).toEqual(['closed', { reason: 'execution-error' }])
})

test('database cancellation retains terminal precedence over an earlier model failure', async () => {
  const f = fixture()
  const cancelled = Promise.withResolvers<void>()
  let cancelling = false
  f.writes.renew = async () => {
    if (cancelling) {
      cancelled.resolve()
      return 'cancel'
    }
    return 'renewed'
  }
  f.deps.harness.run = async () => {
    cancelling = true
    throw new Error('401')
  }
  f.sandbox.close = async () => {
    await cancelled.promise
    f.events.push('closed')
  }
  expect(await executeRun(lease, f.deps, { ...f.options, pollMs: 1 })).toBe('cancelled')
  expect(f.events).toEqual(['closed', 'cancelled'])
})

test('file helper predispatch budget rejection is not an unknown remote write', async () => {
  const f = fixture()
  f.writes.beginEffect = async () => 'limit'
  const deps = {
    ...f.deps,
    fileTools: (_assignment: unknown, files: SandboxFiles, stop: () => void) => ({
      assigned: [],
      prepared: [],
      importFile: async ({ signal }: { signal: AbortSignal }) => {
        try {
          await files.writeBytes('/file', new Uint8Array(), signal)
        } catch (error) {
          stop()
          throw error
        }
        return { bytes: new Uint8Array(), mimeType: 'text/plain' }
      },
      exportFile: async () => {
        throw new Error('unused')
      },
    }),
  }
  deps.harness.run = async (input) => {
    await input.fileTools!.importFile({ assetID: 'asset', path: '/file', signal: input.signal })
    return { text: 'bad' }
  }
  expect(await executeRun(lease, deps, f.options)).toBe('failed')
  expect(f.events).toEqual(['closed', { reason: 'execution-error' }])
})

for (const interruption of ['file-deadline', 'owner-abort'] as const) {
  test(`${interruption} during PUT admission releases only the confirmed unissued reservation`, async () => {
    const f = fixture()
    const gate = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const expired = Promise.withResolvers<void>()
    let effects = 0
    let corrections = 0
    let puts = 0
    let models = 0
    f.writes.reserveModel = async () => {
      models++
      return 'allowed'
    }
    f.writes.beginEffect = async () => {
      effects++
      entered.resolve()
      await gate.promise
      return 'allowed'
    }
    f.writes.rejectEffect = async () => {
      corrections++
      effects--
      return true
    }
    f.sandbox.readBytes = async (_path, signal) => {
      signal.addEventListener('abort', () => expired.resolve(), { once: true })
      return new Uint8Array([1])
    }
    const objects: ObjectStore = {
      read: async () => new Uint8Array(),
      put: async (_key, bytes) => {
        puts++
        return { byteLength: bytes.byteLength, sha256: sha256(bytes) }
      },
      close: () => {},
    }
    const deps = {
      ...f.deps,
      fileTools: assignFileTools(objects, {
        maxBytes: 10,
        maxFiles: 2,
        timeoutMs: interruption === 'file-deadline' ? 20 : 60000,
      }),
    }
    deps.harness.run = async (input) => {
      await input.beforeModel()
      const error = await input
        .fileTools!.exportFile({
          path: '/out',
          name: 'out',
          mimeType: 'text/plain',
          signal: input.signal,
        })
        .catch((cause: unknown) => cause)
      expect(error).toBeInstanceOf(Error)
      expect(effects).toBe(0)
      if (interruption === 'file-deadline') await input.beforeModel()
      return { text: 'safe context' }
    }
    const run = executeRun(lease, deps, f.options)
    await entered.promise
    if (interruption === 'owner-abort') f.shutdown.abort()
    await expired.promise
    gate.resolve()
    expect(await run).toBe(interruption === 'file-deadline' ? 'completed' : 'failed')
    expect(puts).toBe(0)
    expect(corrections).toBe(1)
    expect(effects).toBe(0)
    expect(models).toBe(interruption === 'file-deadline' ? 2 : 1)
    expect(f.events).not.toContain('quarantined')
    // A subsequent safe assignment must not inherit an orphaned effect marker.
    deps.harness.run = async (input) => {
      expect(effects).toBe(0)
      await input.beforeModel()
      return { text: 'next safe context' }
    }
    expect(
      await executeRun(lease, deps, { ...f.options, signal: new AbortController().signal }),
    ).toBe('completed')
    expect(f.events).not.toContain('quarantined')
  })
}

test('owner abort after allowed mutative ACK corrects its marker without invoking the tool', async () => {
  const f = fixture()
  let effects = 0
  let corrections = 0
  f.writes.beginEffect = async () => {
    effects++
    f.shutdown.abort()
    return 'allowed'
  }
  f.writes.rejectEffect = async () => {
    corrections++
    effects--
    return true
  }
  f.deps.harness.run = async (input) => {
    await input.tools.write({ path: '/out', content: 'x', signal: input.signal })
    return { text: 'unreachable' }
  }
  expect(await executeRun(lease, f.deps, f.options)).toBe('failed')
  expect(effects).toBe(0)
  expect(corrections).toBe(1)
  expect(f.events).not.toContain('write')
  expect(f.events).not.toContain('quarantined')
})

for (const correction of ['refused', 'unknown'] as const) {
  test(`${correction} no-IO correction retains uncertainty and the original rejection cause`, async () => {
    const f = fixture()
    const rejection = new CapabilityRejectedError('Local quota rejected before IO')
    const sqlFailure = new Error('Correction transport lost')
    const recoveryFailure = new Error('Recovery transport lost')
    let effects = 0
    let corrections = 0
    f.writes.beginEffect = async () => {
      effects++
      return 'allowed'
    }
    f.sandbox.write = async () => {
      throw rejection
    }
    f.writes.rejectEffect = async () => {
      corrections++
      if (correction === 'unknown') throw sqlFailure
      return false
    }
    f.writes.quarantine = async () => {
      f.events.push('quarantined')
      throw recoveryFailure
    }
    let toolFailure: unknown
    f.deps.harness.run = async (input) => {
      toolFailure = await input.tools
        .write({ path: '/out', content: 'x', signal: input.signal })
        .catch((cause: unknown) => cause)
      throw toolFailure
    }
    const failure = await executeRun(lease, f.deps, f.options).catch((cause: unknown) => cause)
    expect(effects).toBe(1)
    expect(corrections).toBe(1)
    expect(f.events).toContain('quarantined')
    expect(toolFailure).toBeInstanceOf(AggregateError)
    expect((toolFailure as AggregateError).errors[0]).toBe(rejection)
    if (correction === 'unknown') expect((toolFailure as AggregateError).errors[1]).toBe(sqlFailure)
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toContain(toolFailure)
    expect((failure as AggregateError).errors).toContain(recoveryFailure)
  })
}

test('unknown SQL admission ACK cannot create a no-dispatch receipt or refund', async () => {
  const f = fixture()
  let effects = 0
  let corrections = 0
  f.writes.beginEffect = async () => {
    effects++
    throw new Error('SQL ACK lost after commit')
  }
  f.writes.rejectEffect = async () => {
    corrections++
    return true
  }
  f.deps.harness.run = async (input) => {
    await input.tools.write({ path: '/out', content: 'x', signal: input.signal })
    return { text: 'unreachable' }
  }
  expect(await executeRun(lease, f.deps, f.options)).toBe('failed')
  expect(effects).toBe(1)
  expect(corrections).toBe(0)
  expect(f.events).not.toContain('write')
  expect(f.events).toContain('quarantined')
})

test('parallel readonly export failure cannot correct another operation reservation', async () => {
  const f = fixture()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let effects = 0
  let corrections = 0
  f.writes.beginEffect = async () => {
    effects++
    return 'allowed'
  }
  f.writes.rejectEffect = async () => {
    corrections++
    effects--
    return true
  }
  f.sandbox.write = async () => {
    entered.resolve()
    await release.promise
  }
  f.sandbox.readBytes = async () => {
    throw new Error('Readonly export read failed')
  }
  const objects: ObjectStore = {
    read: async () => new Uint8Array(),
    put: async () => {
      throw new Error('PUT must not be invoked')
    },
    close: () => {},
  }
  const deps = {
    ...f.deps,
    fileTools: assignFileTools(objects, { maxBytes: 10, maxFiles: 2, timeoutMs: 1000 }),
  }
  deps.harness.run = async (input) => {
    const write = input.tools.write({ path: '/out', content: 'x', signal: input.signal })
    await entered.promise
    await input
      .fileTools!.exportFile({
        path: '/out',
        name: 'out',
        mimeType: 'text/plain',
        signal: input.signal,
      })
      .catch(() => {})
    expect(effects).toBe(1)
    expect(corrections).toBe(0)
    release.resolve()
    await write
    // Interrupt before checkpoint: the dispatched foreign effect still needs recovery.
    f.shutdown.abort()
    return { text: 'interrupted' }
  }
  expect(await executeRun(lease, deps, f.options)).toBe('failed')
  expect(effects).toBe(1)
  expect(corrections).toBe(0)
  expect(f.events).toContain('quarantined')
})
