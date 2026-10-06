import { expect, test } from 'bun:test'
import {
  executeRun,
  type ExecutionCompletion,
  type ExecutionLease,
  type ExecutionWrites,
  type SandboxSessionPort,
} from './execute-run'

const lease: ExecutionLease = {
  runID: 'run',
  threadID: 'thread',
  text: 'input',
  history: null,
  fence: 1,
  ownerID: 'owner',
}
const sources = [{ title: 'Found', url: 'https://example.org/source' }]

for (const terminal of [
  'completed',
  'cancelled',
  'failed',
  'unknown',
] as const) {
  test(`source products are only offered to successful canonical completion (${terminal})`, async () => {
    const completed: ExecutionCompletion[] = []
    let cancelling = terminal === 'cancelled'
    const writes: ExecutionWrites = {
      saveSandbox: async () => true,
      quarantine: async () => {},
      renew: async () => (cancelling ? 'cancel' : 'renewed'),
      appendText: async () => true,
      complete: async (_lease, completion) => {
        completed.push(completion)
        if (terminal === 'unknown') throw new Error('Unknown COMMIT')
        return true
      },
      cancel: async () => true,
      fail: async () => true,
    }
    const sandbox: SandboxSessionPort = {
      nativeRef: { provider: 'e2b', id: 'fixture' },

      close: async () => {},
      readBytes: async () => new Uint8Array(),
      writeBytes: async () => {},
      execute: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      read: async () => '',
      write: async () => {},
    }
    const execution = executeRun(
      lease,
      {
        writes,
        openSandbox: async () => sandbox,
        harness: {
          turn: async () => {
            if (terminal === 'failed') throw new Error('Turn failed')
            cancelling = false
            return {
              text: 'Final',
              history: { private: 'PRIVATE CANARY' },
              sources,
            }
          },
        },
      },
      { signal: new AbortController().signal, leaseMs: 1000, pollMs: 1000 },
    )
    if (terminal === 'unknown') {
      const error = await execution.catch((error: unknown) => error)
      expect(error).toBeInstanceOf(Error)
      expect(String(error)).toContain('Unknown COMMIT')
      expect(completed).toHaveLength(1)
    } else {
      expect(await execution).toBe(terminal)
      expect(completed).toHaveLength(terminal === 'completed' ? 1 : 0)
    }
    if (terminal === 'completed') expect(completed[0]?.sources).toEqual(sources)
  })
}
