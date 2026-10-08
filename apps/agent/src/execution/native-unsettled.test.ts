import { expect, test } from 'bun:test'
import { executeRun } from './execute-run'
import type { ExecutionLease, ExecutionWrites, SandboxSessionPort } from '../contract'
import { NativeOwnerUnsettledError, type AgentHarness } from '../contract'

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

for (const scenario of [
  'fatal',
  'cancel',
  'commit-unknown',
  'cleanup-unknown',
  'cancel-cleanup-unknown',
  'notification-rejected',
  '401',
] as const) {
  test(`native owner settlement supervision: ${scenario}`, async () => {
    const fatal =
      scenario === '401'
        ? new Error('HTTP 401')
        : new NativeOwnerUnsettledError(new Error('abort receipt unknown'))
    const commit = new Error('Unknown COMMIT')
    const cleanup = new Error('Unknown pause')
    const owner = new AbortController()
    const events: string[] = []
    let cancel = false
    const writes: ExecutionWrites = {
      beginWorkspaceTransition: async () => true,
      settleWorkspaceTransition: async () => true,
      rejectEffect: async () => true,
      reserveModel: async () => (cancel ? 'cancel' : 'allowed'),
      beginEffect: async () => 'allowed',
      checkpoint: async () => true,
      saveSandbox: async () => true,
      appendText: async () => true,
      renew: async () => (cancel ? 'cancel' : 'renewed'),
      quarantine: async () => {
        events.push('quarantine')
      },
      complete: async () => {
        throw new Error('unexpected complete')
      },
      cancel: async () => {
        events.push('cancel')
        return 'cancelled'
      },
      fail: async () => {
        events.push('fail')
        if (scenario === 'commit-unknown') throw commit
        return 'failed'
      },
    }
    const sandbox: SandboxSessionPort = {
      nativeRef: { provider: 'e2b', id: 'fixture' },
      close: async () => {
        events.push('close')
        if (scenario.includes('cleanup-unknown')) throw cleanup
      },
      execute: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      read: async () => '',
      write: async () => {},
      readBytes: async () => new Uint8Array(),
      writeBytes: async () => {},
    }
    const deps = {
      writes,
      openSandbox: async () => sandbox,
      onNativeUnsettled: (error: unknown) => {
        expect(error).toBe(fatal)
        events.push('owner-fail')
        owner.abort(error)
        if (scenario === 'notification-rejected') throw cleanup
      },
      harness: {
        run: async (input: Parameters<AgentHarness['run']>[0]) => {
          if (scenario.startsWith('cancel')) {
            cancel = true
            await input.beforeModel().catch(() => {})
          }
          throw fatal
        },
      },
    }
    const result = await executeRun(lease, deps, {
      signal: owner.signal,
      leaseMs: 1000,
      pollMs: 1000,
    }).catch((error: unknown) => error)
    if (scenario === '401') {
      expect(result).toBe('failed')
      expect(owner.signal.aborted).toBe(false)
      expect(events).toEqual(['close', 'fail'])
    } else {
      expect(owner.signal.aborted).toBe(true)
      expect(events[0]).toBe('owner-fail')
      expect(events).toContain('close')
      if (scenario === 'commit-unknown') expect(result).toBe(commit)
      else if (scenario.includes('cleanup-unknown') || scenario === 'notification-rejected') {
        expect(result).toBeInstanceOf(AggregateError)
        expect((result as AggregateError).errors).toContain(fatal)
        expect((result as AggregateError).errors).toContain(cleanup)
      } else expect(result).toBe(fatal)
      expect(events.at(-1)).toBe(scenario.startsWith('cancel') ? 'cancel' : 'fail')
    }
    if (scenario.includes('cleanup-unknown')) expect(events).toContain('quarantine')
  })
}
