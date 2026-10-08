import { expect, test } from 'bun:test'
import { executeRun } from './execute-run'
import type {
  ExecutionCompletion,
  ExecutionLease,
  ExecutionWrites,
  SandboxSessionPort,
} from '../contract.ts'

const lease: ExecutionLease = {
  runID: 'run',
  threadID: 'thread',
  text: 'input',
  engine: 'pi',
  nativeSessionID: 'session',
  deadlineAt: new Date(Date.now() + 120000),
  restoring: false,
  restoreWorkspace: false,
  fence: 1,
  ownerID: 'owner',
}
const sources = [{ title: 'Found', url: 'https://example.org/source' }]

for (const terminal of ['completed', 'cancelled', 'failed', 'unknown'] as const) {
  test(`source products are only offered to successful canonical completion (${terminal})`, async () => {
    const completed: ExecutionCompletion[] = []
    let cancelling = terminal === 'cancelled'
    const writes: ExecutionWrites = {
      beginWorkspaceTransition: async () => true,
      settleWorkspaceTransition: async () => true,
      rejectEffect: async () => true,
      reserveModel: async () => 'allowed',
      beginEffect: async () => 'allowed',
      checkpoint: async () => true,
      saveSandbox: async () => true,
      quarantine: async () => {},
      renew: async () => (cancelling ? 'cancel' : 'renewed'),
      appendText: async () => true,
      complete: async (_lease, completion) => {
        completed.push(completion)
        if (terminal === 'unknown') throw new Error('Unknown COMMIT')
        return 'completed'
      },
      cancel: async () => 'cancelled',
      fail: async () => 'failed',
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
          run: async () => {
            if (terminal === 'failed') throw new Error('Turn failed')
            cancelling = false
            return {
              text: 'Final',
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
