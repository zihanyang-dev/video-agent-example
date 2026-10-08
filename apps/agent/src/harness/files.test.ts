import { expect, test } from 'bun:test'
import { sha256, type ObjectStore } from '@vid/object-storage'
import {
  CapabilityRejectedError,
  type FileAssignment,
  type SandboxSessionPort,
} from '../contract.ts'
import { assignFileTools } from './files'

function fixture() {
  const bytes = new Uint8Array([0, 255, 128, 13, 10])
  const assetID = crypto.randomUUID()
  const assignment: FileAssignment = {
    threadID: crypto.randomUUID(),
    runID: crypto.randomUUID(),
    fence: 3,
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
  return { bytes, assetID, assignment, guest, stored, sandbox, objects }
}

test('export reauthorizes after readonly guest IO and before the object PUT', async () => {
  const f = fixture()
  let stops = 0
  let authority = true
  let reads = 0
  let puts = 0
  f.sandbox.readBytes = async () => {
    reads++
    authority = false
    return f.bytes
  }
  f.objects.put = async () => {
    puts++
    return { byteLength: f.bytes.byteLength, sha256: sha256(f.bytes) }
  }
  const files = assignFileTools(f.objects, { maxBytes: 10, maxFiles: 2, timeoutMs: 1000 })(
    f.assignment,
    f.sandbox,
    () => {
      stops++
    },
    async () => {
      if (!authority) throw new CapabilityRejectedError('Current request authority rejected PUT')
    },
  )
  expect(
    await files
      .exportFile({
        path: '/output',
        name: 'output.bin',
        mimeType: 'application/octet-stream',
        signal: new AbortController().signal,
      })
      .catch((error: unknown) => error),
  ).toBeInstanceOf(CapabilityRejectedError)
  expect(reads).toBe(1)
  expect(puts).toBe(0)
  expect(files.prepared).toEqual([])
  expect(stops).toBe(0)
})

test('a confirmed local import rejection does not imply an unknown guest write', async () => {
  const f = fixture()
  let stops = 0
  f.sandbox.writeBytes = async () => {
    throw new CapabilityRejectedError('Native mutative admission rejected')
  }
  const files = assignFileTools(f.objects, { maxBytes: 10, maxFiles: 2, timeoutMs: 1000 })(
    f.assignment,
    f.sandbox,
    () => {
      stops++
    },
    async () => {},
  )
  expect(
    await files
      .importFile({ assetID: f.assetID, path: '/input', signal: new AbortController().signal })
      .catch((error: unknown) => error),
  ).toBeInstanceOf(CapabilityRejectedError)
  expect(f.guest.size).toBe(0)
  expect(stops).toBe(0)
})

test('assigned binary import uses Agent path and explicit export prepares immutable allocated bytes', async () => {
  const f = fixture()
  let stops = 0
  const files = assignFileTools(f.objects, {
    maxBytes: 10,
    maxFiles: 2,
    timeoutMs: 1000,
  })(
    f.assignment,
    f.sandbox,
    () => {
      stops++
    },
    async () => {},
  )
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
    `assets/generated/${f.assignment.threadID}/${f.assignment.runID}/3/${output.assetID}`,
  )
  expect(f.stored.get(output.objectKey)).toEqual(f.bytes)
  expect(files.prepared).toEqual([output])
  expect(stops).toBe(0)
})

test('unassigned asset and digest mismatch never write guest bytes', async () => {
  const f = fixture()
  const files = assignFileTools(f.objects, {
    maxBytes: 16,
    maxFiles: 4,
    timeoutMs: 1000,
  })(
    f.assignment,
    f.sandbox,
    () => {},
    async () => {},
  )
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
  })(
    f.assignment,
    f.sandbox,
    () => {
      stopped = true
    },
    async () => {},
  )
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
  expect(files.prepared).toEqual([])
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
    })(
      f.assignment,
      f.sandbox,
      () => {
        stops++
      },
      async () => {},
    )
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
  })
}

for (const action of ['import', 'export'] as const) {
  test(`${action} shares one deadline and awaits the first phase before rejecting the second`, async () => {
    const f = fixture()
    const started = Promise.withResolvers<AbortSignal>()
    const release = Promise.withResolvers<void>()
    let mutations = 0
    let stops = 0
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
    })(
      f.assignment,
      f.sandbox,
      () => {
        stops++
      },
      async () => {},
    )
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
    expect(stops).toBe(0)
  })
}

test('invoked PUT AbortError is unknown and cannot use the no-dispatch receipt', async () => {
  const f = fixture()
  f.guest.set('/out', f.bytes)
  let puts = 0
  let corrections = 0
  let stops = 0
  const rejection = new DOMException('Provider aborted after dispatch', 'AbortError')
  f.objects.put = async () => {
    puts++
    throw rejection
  }
  const files = assignFileTools(f.objects, { maxBytes: 10, maxFiles: 2, timeoutMs: 1000 })(
    f.assignment,
    f.sandbox,
    () => {
      stops++
    },
    async () => async () => {
      corrections++
    },
  )
  const failure = await files
    .exportFile({
      path: '/out',
      name: 'out',
      mimeType: 'application/octet-stream',
      signal: new AbortController().signal,
    })
    .catch((cause: unknown) => cause)
  expect(failure).toBe(rejection)
  expect(puts).toBe(1)
  expect(corrections).toBe(0)
  expect(stops).toBe(1)
  expect(files.prepared).toEqual([])
})
