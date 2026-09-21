import type { Sandbox } from '../../apps/agent/src/application/ports/sandbox'

export const createMemorySandbox = (host = '/tmp'): Sandbox => {
  const files = new Map<string, Uint8Array>()

  return {
    roots: { host, sandbox: '/work' },
    exec: async () => ({ exitCode: 0 }),
    readFile: async (path) => {
      const bytes = files.get(path)
      if (bytes === undefined) throw new Error(`file not found: ${path}`)

      return bytes
    },
    access: async (path) => {
      if (!files.has(path)) throw new Error(`file not found: ${path}`)
    },
    mimeType: async () => null,
    writeFile: async (path, bytes) => {
      files.set(path, bytes)
    },
    mkdir: async () => {},
    list: async () => [...files.keys()].map((path) => path.replace('/work/', '')),
    destroy: async () => {
      files.clear()
    },
  }
}
