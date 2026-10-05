import { expect, test } from 'bun:test'
import { sha256, type ObjectStore } from '@vid/object-storage'
import type { ExecutionLease, RunSandbox } from '../execute-run'
import { assignFileTools } from './files'

function fixture() {
  const bytes = new Uint8Array([0, 255, 128, 13, 10])
  const assetID = crypto.randomUUID()
  const lease: ExecutionLease = {
    threadID: crypto.randomUUID(),
    runID: crypto.randomUUID(),
    commandID: crypto.randomUUID(),
    messageID: crypto.randomUUID(),
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
  const sandbox: RunSandbox = {
    nativeRef: { provider: 'e2b', id: 'native' },
    close: async () => {},
    renewTimeout: async () => {},
    tools: {
      execute: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      read: async () => '',
      write: async () => {},
    },
    files: {
      readBytes: async (path, _signal, maxBytes) => {
        const content = guest.get(path)
        if (!content || content.byteLength > maxBytes)
          throw new Error('Guest read unavailable or oversized')
        return content
      },
      writeBytes: async (path, content) => {
        guest.set(path, content)
      },
    },
  }
  const objects = {
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
  } satisfies ObjectStore
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
  expect(
    files.importFile({ assetID: f.assetID, path: '/chosen', signal }),
  ).rejects.toThrow('digest mismatch')
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
