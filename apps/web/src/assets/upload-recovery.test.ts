import { expect, test } from 'bun:test'
import { MutationObserver, QueryClient } from '@tanstack/react-query'
import { freezeUpload, readUploads, sendUpload } from './pending-uploads'

// Cache Storage is the browser boundary; the SDK, HTTP adapter, Blob, and
// persistence/replay functions remain real. No network request leaves the test.
async function withBrowserStorage(
  check: (failWrites: () => void, failDeletes: () => void) => Promise<void>,
) {
  const cacheDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'caches')
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const stores = new Map<string, Map<string, Response>>()
  let hasWriteFailure = false
  let hasDeleteFailure = false
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { origin: 'http://localhost' } },
  })
  Object.defineProperty(globalThis, 'caches', {
    configurable: true,
    value: {
      open: async (name: string) => {
        let entries = stores.get(name)
        if (!entries) {
          entries = new Map()
          stores.set(name, entries)
        }
        const saved = entries
        return {
          put: async (key: string, response: Response) => {
            if (hasWriteFailure) throw new Error('private storage diagnostic')
            saved.set(key, response.clone())
          },
          keys: async () => [...saved.keys()].map((key) => new Request(key)),
          match: async (key: Request) => saved.get(key.url)?.clone(),
          delete: async (key: string) => {
            if (hasDeleteFailure) throw new Error('private delete failure')
            return saved.delete(key)
          },
        }
      },
    },
  })
  try {
    await check(
      () => {
        hasWriteFailure = true
      },
      () => {
        hasDeleteFailure = true
      },
    )
  } finally {
    if (cacheDescriptor)
      Object.defineProperty(globalThis, 'caches', cacheDescriptor)
    else Reflect.deleteProperty(globalThis, 'caches')
    if (windowDescriptor)
      Object.defineProperty(globalThis, 'window', windowDescriptor)
    else Reflect.deleteProperty(globalThis, 'window')
  }
}

const scope = {
  userID: 'alice',
  threadID: '11111111-1111-4111-8111-111111111111',
}

test('lost upload receipt retains exact binary bytes and ID across account-scoped reload', async () => {
  await withBrowserStorage(async () => {
    const originalFetch = globalThis.fetch
    const requests: { id: string | null; bytes: number[] }[] = []
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        requests.push({
          id: request.headers.get('x-asset-id'),
          bytes: [...new Uint8Array(await request.arrayBuffer())],
        })
        if (requests.length === 1) throw new Error('private lost receipt')
        return Response.json({})
      },
      { preconnect: originalFetch.preconnect },
    )
    try {
      const frozen = await freezeUpload(
        scope,
        new File([new Uint8Array([0, 255, 17])], 'clip.mp4', {
          type: 'video/mp4',
        }),
      )
      try {
        await sendUpload(scope, frozen)
      } catch {
        /* Receipt is intentionally lost. */
      }
      const reloaded = await readUploads(scope)
      expect(reloaded).toHaveLength(1)
      expect(await readUploads({ ...scope, userID: 'bob' })).toEqual([])
      const retry = reloaded[0]
      if (!retry) throw new Error('Expected retained upload')
      await sendUpload(scope, retry)
      expect(requests).toEqual([
        { id: frozen.assetID, bytes: [0, 255, 17] },
        { id: frozen.assetID, bytes: [0, 255, 17] },
      ])
      expect(await readUploads(scope)).toEqual([])
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

test('failed browser byte persistence leaves no sendable upload', async () => {
  await withBrowserStorage(async (failWrites) => {
    failWrites()
    let frozen
    try {
      frozen = await freezeUpload(scope, new File(['bytes'], 'clip.mp4'))
    } catch {
      /* A failed write cannot produce an intent for HTTP dispatch. */
    }
    expect(frozen).toBeUndefined()
    expect(await readUploads(scope)).toEqual([])
  })
})

test('cache cleanup failure after HTTP acceptance retains an exact retry rather than losing bytes', async () => {
  await withBrowserStorage(async (_failWrites, failDeletes) => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = Object.assign(async () => Response.json({}), {
      preconnect: originalFetch.preconnect,
    })
    try {
      const frozen = await freezeUpload(
        scope,
        new File(['retained bytes'], 'clip.mp4'),
      )
      failDeletes()
      const client = new QueryClient()
      const mutation = new MutationObserver(client, {
        mutationFn: () => sendUpload(scope, frozen),
      })
      const unsubscribe = mutation.subscribe(() => {})
      let outcome
      try {
        outcome = await mutation.mutate(undefined)
        expect(mutation.getCurrentResult().isSuccess).toBe(true)
      } finally {
        unsubscribe()
        client.clear()
      }
      expect(outcome.storageError).toBe(
        'File accepted, but its saved upload could not be removed. Check Chat history before retrying.',
      )
      expect(outcome.storageError).not.toContain('private')
      const restored = await readUploads(scope)
      expect(restored[0]?.assetID).toBe(frozen.assetID)
      expect(await restored[0]?.bytes.text()).toBe('retained bytes')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

test('confirmed 415 refusal can be explicitly forgotten locally before choosing valid bytes; 503 retains exact replay', async () => {
  await withBrowserStorage(async () => {
    const originalFetch = globalThis.fetch
    const requests: { id: string | null; bytes: string }[] = []
    const { discardUpload } = await import('./pending-uploads')
    let status = 415
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        requests.push({
          id: request.headers.get('x-asset-id'),
          bytes: await request.text(),
        })
        return Response.json({}, { status })
      },
      { preconnect: originalFetch.preconnect },
    )
    try {
      const invalid = await freezeUpload(
        scope,
        new File(['invalid'], 'clip.mp4'),
      )
      const refusal = await sendUpload(scope, invalid).catch(
        (failure: unknown) => failure,
      )
      expect(refusal).toMatchObject({ status: 415 })
      expect(await readUploads(scope)).toHaveLength(1)
      await discardUpload(scope, invalid)
      // Cache.delete(false) means already absent, not a cleanup error.
      await discardUpload(scope, invalid)
      expect(await readUploads(scope)).toEqual([])
      const valid = await freezeUpload(
        scope,
        new File(['valid fixture'], 'notes.txt', { type: 'text/plain' }),
      )
      status = 503
      const lost = await sendUpload(scope, valid).catch(
        (failure: unknown) => failure,
      )
      expect(lost).toMatchObject({ status: 503 })
      const restored = (await readUploads(scope))[0]
      if (!restored) throw new Error('Expected retained bytes')
      status = 200
      await sendUpload(scope, restored)
      expect(requests).toEqual([
        { id: invalid.assetID, bytes: 'invalid' },
        { id: valid.assetID, bytes: 'valid fixture' },
        { id: valid.assetID, bytes: 'valid fixture' },
      ])
      expect(valid.assetID).not.toBe(invalid.assetID)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

// The rendered recovery controls must offer a local-only escape hatch without
// making an unchecked acknowledgment look actionable, even after a known refusal.
test.each([
  ['refused', 'File refused by server'],
  ['accepted', 'File accepted; saved upload retained'],
  [undefined, 'Upload acceptance unknown'],
] as const)(
  'upload recovery renders %s with acknowledgment-gated local discard',
  async (outcome, label) => {
    const { createElement } = await import('react')
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { UploadRecovery } = await import('./chat-assets')
    const html = renderToStaticMarkup(
      createElement(UploadRecovery, {
        name: 'notes.txt',
        outcome,
        disabled: false,
        retry: () => {
          throw new Error('SSR must not send')
        },
        forget: () => {
          throw new Error('SSR must not erase')
        },
      }),
    )
    expect(html).toContain(label)
    expect(html).toContain('Check Chat history before forgetting')
    expect(html).toMatch(
      /<button(?![^>]*disabled)[^>]*>Retry same file<\/button>/,
    )
    expect(html).toMatch(
      /<button[^>]*disabled=""[^>]*>Forget saved upload locally and choose another file<\/button>/,
    )
    expect(html).toContain('not server files')
  },
)
