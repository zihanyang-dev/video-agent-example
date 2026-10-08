import { afterAll, expect, test } from 'bun:test'
import { sql } from 'kysely'
import { acceptExecutionCommand } from '../../apps/agent/src/execution/db/command-acceptance'
import { claimExecutionRun } from '../../apps/agent/src/execution/db/execution-leases'
import { bindExecutionWrites } from '../../apps/agent/src/execution/db/run-writes'
import type { StartCommand } from '@vid/contract/execution'
import { clearOwnedExecutionThread, openTestDatabase } from './database-fixture'

const { db, close } = openTestDatabase()
const threads: string[] = []

afterAll(async () => {
  try {
    for (const threadID of threads) {
      await clearOwnedExecutionThread(db, threadID)
    }
  } finally {
    await close()
  }
})

async function accepted() {
  const threadID = crypto.randomUUID()
  threads.push(threadID)
  const command: StartCommand = {
    version: 1,
    kind: 'start',
    commandID: crypto.randomUUID(),
    threadID,
    runID: crypto.randomUUID(),
    input: { messageID: crypto.randomUUID(), text: 'Continue one native conversation.' },
  }
  expect(await acceptExecutionCommand(db, command)).toBe('accepted')
  return command
}

test('assigns the requested native engine once without transferring a transcript', async () => {
  const command = await accepted()
  const options = {
    ownerID: 'owned-native-worker',
    leaseMs: 60000,
    defaultEngine: 'openai' as const,
    requestTimeoutMs: 120000,
  }
  const lease = await claimExecutionRun(db, options)
  expect(lease?.threadID).toBe(command.threadID)
  expect(lease?.engine).toBe('openai')
  expect(lease?.nativeSessionID).toMatch(/^[0-9a-f-]{36}$/)
  expect(lease).not.toHaveProperty('history')
  expect(lease?.restoring).toBe(false)
  expect(lease?.deadlineAt.getTime()).toBeGreaterThan(Date.now())
})

test('model reservations consume the original request allowance before dispatch', async () => {
  const command = await accepted()
  const lease = await claimExecutionRun(db, { ownerID: 'owned-model-worker', leaseMs: 60000 })
  if (lease === null || lease.runID !== command.runID) throw new Error('Expected owned request')
  const writes = bindExecutionWrites(db)
  for (let count = 0; count < 16; count++) expect(await writes.reserveModel(lease)).toBe('allowed')
  expect(await writes.reserveModel(lease)).toBe('limit')
  expect(await writes.reserveModel({ ...lease, fence: lease.fence + 1 })).toBe('lost')
})

test('only the current native checkpoint can settle issued effects', async () => {
  const command = await accepted()
  const lease = await claimExecutionRun(db, { ownerID: 'owned-effect-worker', leaseMs: 60000 })
  if (lease === null || lease.runID !== command.runID) throw new Error('Expected owned request')
  const writes = bindExecutionWrites(db)
  expect(await writes.beginEffect(lease)).toBe('allowed')
  expect(await writes.beginEffect(lease)).toBe('allowed')
  expect(await writes.checkpoint({ ...lease, fence: lease.fence + 1 })).toBe(false)
  const pending = await sql<{
    uncheckpointed_effects: number
  }>`select uncheckpointed_effects from execution.runs where run_id=${lease.runID}::uuid`.execute(
    db,
  )
  expect(pending.rows[0]?.uncheckpointed_effects).toBe(2)
  expect(await writes.checkpoint(lease)).toBe(true)
  const settled = await sql<{
    uncheckpointed_effects: number
  }>`select uncheckpointed_effects from execution.runs where run_id=${lease.runID}::uuid`.execute(
    db,
  )
  expect(settled.rows[0]?.uncheckpointed_effects).toBe(0)
})
