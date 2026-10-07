import { expect, test } from 'bun:test'
import { sha256, type ObjectStore } from '@vid/object-storage'
import type { ExecutionLease, SandboxSessionPort } from '../execution/contract'
import { assignFileTools } from './files'
import { fileToolDefinitions } from './file-tools'

function fixture() {
  const bytes = new Uint8Array([0, 255, 128, 13, 10])
  const assetID = crypto.randomUUID()
  const lease: ExecutionLease = {
    threadID: crypto.randomUUID(),
    runID: crypto.randomUUID(),
    text: '',
    fence: 3,
    ownerID: 'worker',
    history: [],
    assets: [
      {
        assetID,
        objectKey: 'allocated-input',
        name: 'source.bin',
        mimeType: 'application/octet-stream',
        byteLength: 5,
        sha256: sha256(bytes),
      },
    ],
  }
  const guest = new Map<string, Uint8Array>()
  const stored = new Map<string, Uint8Array>([['allocated-input', bytes]])
  const sandbox: SandboxSessionPort = {
    nativeRef: { provider: 'e2b', id: 'native' },
    close: async () => {},

    execute: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    read: async () => '',
    write: async () => {},
    readBytes: async (path, _signal, maxBytes) => {
      const content = guest.get(path)
      if (!content || content.byteLength > maxBytes)
        throw new Error('Guest read unavailable or oversized')
      return content
    },
    writeBytes: async (path, content) => {
      guest.set(path, content)
    },
  }
  const objects: ObjectStore = {
    read: async (key) => {
      const content = stored.get(key)
      if (!content) throw new Error('Missing object')
      return content
    },
    put: async (key, content) => {
      if (stored.has(key)) throw new Error('Immutable key exists')
      stored.set(key, content)
      return { byteLength: content.byteLength, sha256: sha256(content) }
    },
    close: () => {},
  }
  return { bytes, assetID, lease, guest, stored, sandbox, objects }
}

test('assigned binary import uses Agent path and explicit export prepares immutable allocated bytes', async () => {
  const f = fixture()
  const files = assignFileTools(f.objects, {
    maxBytes: 10,
    maxFiles: 2,
    timeoutMs: 1000,
  })(f.lease, f.sandbox, () => {})
  const signal = AbortSignal.timeout(1000)
  await files.importFile({
    assetID: f.assetID,
    path: '/home/user/chosen-source',
    signal,
  })
  expect(f.guest.get('/home/user/chosen-source')).toEqual(f.bytes)
  const output = await files.exportFile({
    path: '/home/user/chosen-source',
    name: 'delivery.bin',
    mimeType: 'application/octet-stream',
    signal,
  })
  expect(output.objectKey).toBe(
    `assets/generated/${f.lease.threadID}/${f.lease.runID}/3/${output.assetID}`,
  )
  expect(f.stored.get(output.objectKey)).toEqual(f.bytes)
  expect(files.prepared).toEqual([output])
  expect(files.hasUnknownOutcome()).toBe(false)
})

test('unassigned asset and digest mismatch never write guest bytes', async () => {
  const f = fixture()
  const files = assignFileTools(f.objects, {
    maxBytes: 16,
    maxFiles: 4,
    timeoutMs: 1000,
  })(f.lease, f.sandbox, () => {})
  const signal = AbortSignal.timeout(1000)
  expect(
    files.importFile({ assetID: crypto.randomUUID(), path: '/chosen', signal }),
  ).rejects.toThrow('not assigned')
  f.stored.set('allocated-input', new Uint8Array([1, 2, 3, 4, 5]))
  expect(files.importFile({ assetID: f.assetID, path: '/chosen', signal })).rejects.toThrow(
    'digest mismatch',
  )
  expect(f.guest.size).toBe(0)
})

test('lost upload ACK keeps possibly committed bytes and aborts spending without preparing publication', async () => {
  const f = fixture()
  f.guest.set('/chosen', f.bytes)
  const put = f.objects.put.bind(f.objects)
  f.objects.put = async (...request) => {
    await put(...request)
    throw new Error('PUT acknowledgement lost')
  }
  let stopped = false
  const files = assignFileTools(f.objects, {
    maxBytes: 16,
    maxFiles: 4,
    timeoutMs: 1000,
  })(f.lease, f.sandbox, () => {
    stopped = true
  })
  expect(
    files.exportFile({
      path: '/chosen',
      name: 'delivery.bin',
      mimeType: 'application/octet-stream',
      signal: AbortSignal.timeout(1000),
    }),
  ).rejects.toThrow('acknowledgement lost')
  await Bun.sleep(5)
  expect(stopped).toBe(true)
  expect(files.hasUnknownOutcome()).toBe(true)
  expect(files.prepared).toEqual([])
  expect(f.stored.size).toBe(2)
})

test('file and aggregate byte budgets reject exports before object upload', async () => {
  const f = fixture()
  f.guest.set('/chosen', f.bytes)
  const files = assignFileTools(f.objects, {
    maxBytes: 5,
    maxFiles: 1,
    timeoutMs: 1000,
  })(f.lease, f.sandbox, () => {})
  const request = {
    path: '/chosen',
    name: 'delivery.bin',
    mimeType: 'application/octet-stream',
    signal: AbortSignal.timeout(1000),
  }
  await files.exportFile(request)
  expect(files.exportFile(request)).rejects.toThrow()
  expect(f.stored.size).toBe(2)
})

for (const budget of ['count', 'bytes'] as const) {
  test(`${budget} exhaustion rejects before a second guest read without marking uncertainty`, async () => {
    const f = fixture()
    f.guest.set('/chosen', f.bytes)
    let reads = 0
    let stops = 0
    const read = f.sandbox.readBytes
    f.sandbox.readBytes = async (...args) => {
      reads++
      return await read(...args)
    }
    const files = assignFileTools(f.objects, {
      maxBytes: budget === 'count' ? 100 : 5,
      maxFiles: budget === 'count' ? 1 : 10,
      timeoutMs: 1000,
    })(f.lease, f.sandbox, () => {
      stops++
    })
    const request = {
      path: '/chosen',
      name: 'out.bin',
      mimeType: 'application/octet-stream',
      signal: new AbortController().signal,
    }
    await files.exportFile(request)
    const rejection = await files.exportFile(request).catch((cause: unknown) => cause)
    expect(rejection).toBeInstanceOf(Error)
    expect(rejection instanceof Error && rejection.message).toContain('budget exceeded')
    expect(reads).toBe(1)
    expect(f.stored.size).toBe(2)
    expect(stops).toBe(0)
    expect(files.hasUnknownOutcome()).toBe(false)
  })
}

for (const action of ['import', 'export'] as const) {
  test(`${action} shares one deadline and awaits the first phase before rejecting the second`, async () => {
    const f = fixture()
    const started = Promise.withResolvers<AbortSignal>()
    const release = Promise.withResolvers<void>()
    let mutations = 0
    if (action === 'import') {
      f.objects.read = async (_key, _max, signal) => {
        started.resolve(signal)
        await release.promise
        return f.bytes
      }
      f.sandbox.writeBytes = async () => {
        mutations++
      }
    } else {
      f.sandbox.readBytes = async (_path, signal) => {
        started.resolve(signal)
        await release.promise
        return f.bytes
      }
      f.objects.put = async (_key, bytes) => {
        mutations++
        return { byteLength: bytes.byteLength, sha256: sha256(bytes) }
      }
    }
    const files = assignFileTools(f.objects, {
      maxBytes: 100,
      maxFiles: 10,
      timeoutMs: 10,
    })(f.lease, f.sandbox, () => {})
    const signal = new AbortController().signal
    const operation =
      action === 'import'
        ? files.importFile({ assetID: f.assetID, path: '/chosen', signal })
        : files.exportFile({
            path: '/chosen',
            name: 'out.bin',
            mimeType: 'application/octet-stream',
            signal,
          })
    let settled = false
    const outcome = operation.finally(() => {
      settled = true
    })
    const deadline = await started.promise
    try {
      await new Promise<void>((resolve) => {
        if (deadline.aborted) resolve()
        else deadline.addEventListener('abort', () => resolve(), { once: true })
      })
      expect(settled).toBe(false)
    } finally {
      release.resolve()
    }
    expect(await outcome.catch((cause: unknown) => cause)).toBeInstanceOf(Error)
    expect(mutations).toBe(0)
    expect(files.hasUnknownOutcome()).toBe(false)
  })
}

test('file import retains owner cancellation while an independent SDK signal is active', async () => {
  const owner = new AbortController()
  const sdk = new AbortController()
  const started = Promise.withResolvers<AbortSignal>()
  const files = {
    assigned: [],
    prepared: [],
    hasUnknownOutcome: () => false,
    importFile: async ({ signal }: { signal: AbortSignal }) => {
      started.resolve(signal)
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true })
        if (signal.aborted) resolve()
      })
      signal.throwIfAborted()
      return { bytes: new Uint8Array(), mimeType: 'text/plain' }
    },
    exportFile: async () => {
      throw new Error('Unexpected export')
    },
  }
  const tool = fileToolDefinitions(files, owner.signal, false, () => {
    throw new Error('Unexpected budget refusal')
  })[0]!
  const context = {} as Parameters<typeof tool.execute>[4]
  const reason = new Error('assigned owner cancellation')
  const pending = tool.execute(
    'fixture',
    { assetID: crypto.randomUUID(), path: '/chosen' },
    sdk.signal,
    undefined,
    context,
  )
  void pending.catch(() => {})
  try {
    const cancellation = await started.promise
    owner.abort(reason)
    expect(cancellation.aborted).toBe(true)
    expect(cancellation.reason).toBe(reason)
    expect(await pending.catch((cause: unknown) => cause)).toBe(reason)
  } finally {
    sdk.abort(reason)
    await pending.catch(() => {})
  }
})

test('native file definitions guard SDK cancellation before capabilities', async () => {
  let invoked = 0
  const files = {
    assigned: [],
    prepared: [],
    hasUnknownOutcome: () => false,
    importFile: async () => {
      invoked++
      return { bytes: new Uint8Array(), mimeType: 'image/png' }
    },
    exportFile: async () => {
      invoked++
      throw new Error('unexpected')
    },
  }
  const definitions = fileToolDefinitions(files, new AbortController().signal, true, () => {
    throw new Error('Unexpected byte limit')
  })
  const importTool = definitions[0]!
  const context = {} as Parameters<typeof importTool.execute>[4]
  const reason = new Error('owner cancellation')
  const aborted = AbortSignal.abort(reason)
  const rejected = await importTool
    .execute(
      'fixture',
      { assetID: crypto.randomUUID(), path: '/chosen' },
      aborted,
      undefined,
      context,
    )
    .catch((error: unknown) => error)
  expect(rejected).toBe(reason)
  expect(invoked).toBe(0)
})
