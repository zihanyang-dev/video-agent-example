import { afterAll, afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acceptExecutionCommand } from '../../apps/agent/src/execution/db/command-acceptance'
import {
  claimExecutionRun,
  recoverNativeRequests,
} from '../../apps/agent/src/execution/db/execution-leases'
import { bindExecutionWrites } from '../../apps/agent/src/execution/db/run-writes'
import { createOpenAIHarness } from '../../apps/agent/src/harness/openai/adapter'
import { writeJSON } from '../../apps/agent/src/harness/openai/session'
import { executionEventSchema, type StartCommand } from '@vid/contract/execution'
import { clearOwnedExecutionThread, openTestDatabase } from './database-fixture'

const { db, close } = openTestDatabase()
const threads = new Set<string>()
const directories = new Set<string>()
afterEach(async () => {
  for (const threadID of threads) {
    await clearOwnedExecutionThread(db, threadID)
    threads.delete(threadID)
  }
  for (const directory of directories) {
    await rm(directory, { recursive: true, force: true })
    directories.delete(directory)
  }
})
afterAll(close)

async function fixture() {
  const command: StartCommand = {
    version: 1,
    kind: 'start',
    commandID: crypto.randomUUID(),
    threadID: crypto.randomUUID(),
    runID: crypto.randomUUID(),
    input: { messageID: crypto.randomUUID(), text: 'Recover the native final without spending.' },
  }
  threads.add(command.threadID)
  expect(await acceptExecutionCommand(db, command)).toBe('accepted')
  const lease = await claimExecutionRun(db, {
    ownerID: 'native-completion-test',
    leaseMs: 60000,
    defaultEngine: 'openai',
  })
  if (lease?.runID !== command.runID) throw new Error('Expected owned request')
  const statePath = await mkdtemp(join(tmpdir(), 'native-completion-'))
  directories.add(statePath)
  const harness = createOpenAIHarness({
    statePath,
    baseURL: 'http://127.0.0.1:1',
    key: 'unused',
    modelID: 'unused',
    contextWindow: 10000,
    maxOutputTokens: 100,
    input: ['text'],
    systemPrompt: 'unused',
    reasoning: null,
  })
  const path = join(statePath, 'openai', lease.threadID, 'runs', `${lease.runID}.json`)
  await writeJSON(path, {
    nativeSessionID: lease.nativeSessionID,
    state: 'private SDK state never copied to SQL',
    sources: [],
    assets: [],
    completion: { text: 'Durable native answer' },
  })
  return { lease, path, completed: harness.completed! }
}

async function state(runID: string) {
  const run = await db
    .selectFrom('execution.runs')
    .selectAll()
    .where('run_id', '=', runID)
    .executeTakeFirstOrThrow()
  const conversation = await db
    .selectFrom('execution.conversations')
    .selectAll()
    .where('thread_id', '=', run.thread_id)
    .executeTakeFirstOrThrow()
  const events = (
    await db
      .selectFrom('execution.event_outbox')
      .select('event')
      .where('run_id', '=', runID)
      .orderBy('ordinal')
      .execute()
  ).map(({ event }) => executionEventSchema.parse(event))
  return { run, conversation, events }
}

for (const effects of [0, 1]) {
  test(`native final reconciles expired full allowances and ${effects} unacknowledged effects exactly once`, async () => {
    const { lease, completed } = await fixture()
    const deadline = new Date(Date.now() - 60000)
    await db
      .updateTable('execution.runs')
      .set({
        deadline_at: deadline,
        model_call_count: 16,
        resume_count: 2,
        uncheckpointed_effects: effects,
      })
      .where('run_id', '=', lease.runID)
      .execute()
    let reads = 0
    const readCompleted: typeof completed = async (identity) => {
      reads++
      expect(identity).toEqual({
        engine: lease.engine,
        threadID: lease.threadID,
        nativeSessionID: lease.nativeSessionID,
        nativeSessionStorage: 'legacy',
        requireExisting: false,
        runID: lease.runID,
      })
      return await completed(identity)
    }
    await recoverNativeRequests(db, readCompleted)
    await recoverNativeRequests(db, readCompleted)
    expect(reads).toBe(1)
    const { run, conversation, events } = await state(lease.runID)
    expect(run.status).toBe('completed')
    expect(run.deadline_at).toEqual(deadline)
    expect(run.model_call_count).toBe(16)
    expect(run.resume_count).toBe(2)
    expect(run.uncheckpointed_effects).toBe(0)
    expect(conversation.active_run_id).toBeNull()
    expect(conversation.fence).toBe(lease.fence + 1)
    expect(conversation.sandbox_recovery_required).toBe(false)
    expect(events.map((event) => event.kind)).toEqual(['run-started', 'run-completed'])
    expect(events[1]).toMatchObject({ text: 'Durable native answer' })
    expect(JSON.stringify(events)).not.toContain('private SDK state')
    expect(await bindExecutionWrites(db).complete(lease, { text: 'stale writer' })).toBe('lost')
  })
}

test('durable cancellation wins without reading native state', async () => {
  const { lease } = await fixture()
  await db
    .updateTable('execution.runs')
    .set({ cancel_requested: true })
    .where('run_id', '=', lease.runID)
    .execute()
  await recoverNativeRequests(db, async () => {
    throw new Error('Cancellation must not inspect native state')
  })
  const { run, events } = await state(lease.runID)
  expect(run.status).toBe('cancelled')
  expect(events.map((event) => event.kind)).toEqual(['run-started', 'run-cancelled'])
})

for (const flag of [
  'sandbox_recovery_required',
  'workspace_transition_pending',
  'legacy_import_required',
] as const) {
  test(`does not inspect or discard native state when ${flag}`, async () => {
    const { lease } = await fixture()
    await db
      .updateTable('execution.conversations')
      .set({ [flag]: true })
      .where('thread_id', '=', lease.threadID)
      .execute()
    await recoverNativeRequests(db, async () => {
      throw new Error('Physical uncertainty must not inspect native state')
    })
    const { run, conversation, events } = await state(lease.runID)
    expect(run.status).toBe('failed')
    expect(events.map((event) => event.kind)).toEqual(['run-started', 'run-failed'])
    if (flag !== 'legacy_import_required') expect(conversation.sandbox_recovery_required).toBe(true)
  })
}

for (const failure of ['native-id', 'engine', 'malformed', 'callback'] as const) {
  test(`${failure} failure rolls back recovery rather than claiming clean workspace`, async () => {
    const { lease, path, completed } = await fixture()
    if (failure === 'native-id')
      await writeJSON(path, {
        nativeSessionID: crypto.randomUUID(),
        completion: { text: 'Wrong session' },
      })
    const getCompleted =
      failure === 'engine'
        ? () => completed({ ...lease, engine: 'pi' })
        : failure === 'malformed'
          ? async () => ({ text: 42 }) as unknown as { text: string }
          : failure === 'callback'
            ? async () => {
                throw new Error('Storage failure')
              }
            : completed
    const error = await recoverNativeRequests(db, getCompleted).then(
      () => undefined,
      (cause: unknown) => cause,
    )
    expect(error).toBeInstanceOf(Error)
    const { run, conversation, events } = await state(lease.runID)
    expect(run.status).toBe('running')
    expect(conversation.active_run_id).toBe(lease.runID)
    expect(conversation.fence).toBe(lease.fence)
    expect(conversation.workspace_reset_required).toBe(false)
    expect(events.map((event) => event.kind)).toEqual(['run-started'])
  })
}

for (const status of ['completed', 'cancelled', 'failed'] as const) {
  test(`stale active pointer never resurrects ${status} or duplicates its receipt`, async () => {
    const { lease } = await fixture()
    const writes = bindExecutionWrites(db)
    if (status === 'completed') await writes.complete(lease, { text: 'Original terminal' })
    else if (status === 'cancelled') await writes.cancel(lease)
    else await writes.fail(lease, 'execution-error')
    await db
      .updateTable('execution.conversations')
      .set({
        active_run_id: lease.runID,
        lease_owner: lease.ownerID,
        lease_until: new Date(Date.now() + 60000),
      })
      .where('thread_id', '=', lease.threadID)
      .execute()
    await recoverNativeRequests(db, async () => {
      throw new Error('Terminal must not inspect native state')
    })
    const { run, events } = await state(lease.runID)
    expect(run.status).toBe(status)
    expect(events.map((event) => event.kind)).toEqual(['run-started', `run-${status}`])
  })
}

test('a missing native final preserves original safe-resume accounting', async () => {
  const { lease } = await fixture()
  await recoverNativeRequests(db, async () => undefined)
  const { run, conversation, events } = await state(lease.runID)
  expect(run.status).toBe('queued')
  expect(run.resume_count).toBe(1)
  expect(run.deadline_at).toEqual(lease.deadlineAt)
  expect(conversation.fence).toBe(lease.fence + 1)
  expect(events.map((event) => event.kind)).toEqual(['run-started'])
})

test('an unknown write without a durable final remains quarantined and is not replayed', async () => {
  const { lease } = await fixture()
  await db
    .updateTable('execution.runs')
    .set({ uncheckpointed_effects: 1 })
    .where('run_id', '=', lease.runID)
    .execute()
  await recoverNativeRequests(db, async () => undefined)
  const { run, conversation, events } = await state(lease.runID)
  expect(run.status).toBe('failed')
  expect(run.uncheckpointed_effects).toBe(1)
  expect(conversation.sandbox_recovery_required).toBe(true)
  expect(events.map((event) => event.kind)).toEqual(['run-started', 'run-failed'])
  expect(events[1]).toMatchObject({ reason: 'sandbox-recovery-required' })
})
