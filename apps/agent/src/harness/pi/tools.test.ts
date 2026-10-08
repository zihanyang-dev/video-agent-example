import { expect, test } from 'bun:test'
import type { FileTools, SandboxTools } from '../../contract.ts'
import { createToolDefinitions } from './tools.ts'

const unusedSandbox: SandboxTools = {
  execute: async () => {
    throw new Error('Unexpected execute')
  },
  read: async () => {
    throw new Error('Unexpected read')
  },
  write: async () => {
    throw new Error('Unexpected write')
  },
}

function options(signal: AbortSignal, fileTools: FileTools) {
  return {
    tools: unusedSandbox,
    signal,
    fileTools,
    supportsImages: false,
    onLimit: (): never => {
      throw new Error('Unexpected budget refusal')
    },
  }
}

test('file import retains owner cancellation while an independent SDK signal is active', async () => {
  const owner = new AbortController()
  const sdk = new AbortController()
  const started = Promise.withResolvers<AbortSignal>()
  const files: FileTools = {
    assigned: [],
    prepared: [],
    importFile: async ({ signal }) => {
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
  const tool = createToolDefinitions(options(owner.signal, files)).find(
    (tool) => tool.name === 'import_file',
  )!
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

for (const [name, arguments_] of [
  ['execute', { command: 'render' }],
  ['read', { path: '/chosen' }],
  ['write', { path: '/chosen', content: 'bytes' }],
  ['import_file', { assetID: '11111111-1111-4111-8111-111111111111', path: '/chosen' }],
  ['export_file', { path: '/chosen', name: 'out.bin', mimeType: 'application/octet-stream' }],
  ['web_search', { query: 'public facts' }],
] as const) {
  test(`native ${name} rejects SDK cancellation before capability dispatch`, async () => {
    let dispatched = 0
    const files: FileTools = {
      assigned: [],
      prepared: [],
      importFile: async () => {
        dispatched++
        return { bytes: new Uint8Array(), mimeType: 'image/png' }
      },
      exportFile: async () => {
        dispatched++
        throw new Error('Unexpected export')
      },
    }
    const tools: SandboxTools = {
      execute: async () => {
        dispatched++
        throw new Error('Unexpected execute')
      },
      read: async () => {
        dispatched++
        return 'bytes'
      },
      write: async () => {
        dispatched++
      },
    }
    const native = createToolDefinitions({
      ...options(new AbortController().signal, files),
      tools,
      webSearch: {
        authMode: 'keyless',
        transport: async () => {
          dispatched++
          return Response.json({ results: [] })
        },
      },
    }).find((tool) => tool.name === name)!
    const reason = new Error('SDK cancellation')
    const outcome = await native
      .execute(
        'fixture',
        arguments_,
        AbortSignal.abort(reason),
        undefined,
        {} as Parameters<typeof native.execute>[4],
      )
      .catch((error: unknown) => error)
    expect(outcome).toBe(reason)
    expect(dispatched).toBe(0)
  })
}
