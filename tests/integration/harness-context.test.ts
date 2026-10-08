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
import {
  requestHarness,
  readNativeRequestIdentity,
} from '../../apps/agent/src/execution/db/session-bindings'
import { createPiHarness } from '../../apps/agent/src/harness/pi/adapter'
import { createOpenAIHarness } from '../../apps/agent/src/harness/openai/adapter'
import { writeJSON } from '../../apps/agent/src/harness/openai/session'
import type { HarnessEngine } from '../../apps/agent/src/contract'
import type { StartCommand } from '@vid/contract/execution'
import { clearOwnedExecutionThread, openTestDatabase } from './database-fixture'

const { db, close } = openTestDatabase()
const threads: string[] = []

afterEach(async () => {
  for (const threadID of threads) {
    await clearOwnedExecutionThread(db, threadID)
  }
  threads.length = 0
})
afterAll(close)

async function accept(threadID: string, text: string) {
  const command: StartCommand = {
    version: 1,
    kind: 'start',
    threadID,
    commandID: crypto.randomUUID(),
    runID: crypto.randomUUID(),
    input: { messageID: crypto.randomUUID(), text },
  }
  expect(await acceptExecutionCommand(db, command)).toBe('accepted')
  return command
}

function thread() {
  const id = crypto.randomUUID()
  threads.push(id)
  return id
}

test('FIFO admission reads only the next queued run body', async () => {
  const threadID = thread()
  await accept(threadID, 'First queued request.')
  await accept(threadID, 'Second queued request.')
  await accept(threadID, 'Third queued request.')
  const first = await db
    .selectFrom('execution.runs')
    .select('run_id')
    .where('thread_id', '=', threadID)
    .orderBy('created_at')
    .orderBy('run_id')
    .limit(1)
    .executeTakeFirstOrThrow()
  let queuedBodies = 0
  const observed = db.withPlugin({
    transformQuery: ({ node }) => node,
    async transformResult({ result }) {
      queuedBodies = Math.max(
        queuedBodies,
        result.rows.filter((row) => row.status === 'queued').length,
      )
      return result
    },
  })
  const lease = await claimExecutionRun(observed, {
    ownerID: 'bounded-fifo-worker',
    leaseMs: 60000,
  })
  expect(lease?.runID).toBe(first.run_id)
  expect(queuedBodies).toBe(1)
})

test('trusted harness selection applies to a new run without changing the public command', async () => {
  const command = await accept(thread(), 'Use the selected executor.')
  const current = await db
    .selectFrom('execution.conversations')
    .select('native_session_id')
    .where('thread_id', '=', command.threadID)
    .executeTakeFirstOrThrow()
  expect(
    await requestHarness(db, {
      threadID: command.threadID,
      nativeSessionID: current.native_session_id,
      engine: 'openai',
    }),
  ).toBe('accepted')
  const lease = await claimExecutionRun(db, { ownerID: 'owned-context-worker', leaseMs: 60000 })
  expect(lease?.runID).toBe(command.runID)
  expect(lease?.engine).toBe('openai')
  expect(command).not.toHaveProperty('engine')
})

test('a new harness receives completed business turns without resetting the prior request', async () => {
  const threadID = thread()
  const first = await accept(threadID, 'Remember the conversation-only constraint: alpha.')
  const lease = await claimExecutionRun(db, {
    ownerID: 'owned-first-context-worker',
    leaseMs: 60000,
  })
  if (lease === null || lease.runID !== first.runID) throw new Error('Expected owned lease')
  const writes = bindExecutionWrites(db)
  expect(await writes.reserveModel(lease)).toBe('allowed')
  expect(await writes.checkpoint(lease)).toBe(true)
  expect(
    await writes.complete(lease, { text: 'Completed first task; the constraint is alpha.' }),
  ).toBe('completed')
  const second = await accept(threadID, 'Continue only this new task.')
  expect(
    await requestHarness(db, {
      threadID,
      nativeSessionID: lease.nativeSessionID,
      engine: 'openai',
    }),
  ).toBe('accepted')
  const next = await claimExecutionRun(db, {
    ownerID: 'owned-second-context-worker',
    leaseMs: 60000,
    getCompleted: async (identity) => {
      if (identity.nativeSessionID !== lease.nativeSessionID || identity.runID !== first.runID)
        throw new Error('Expected original native identity')
      return { text: 'Completed first task; the constraint is alpha.' }
    },
  })
  if (next === null || next.initialContext === undefined)
    throw new Error('Expected assigned context')
  expect(next.runID).toBe(second.runID)
  expect(next.engine).toBe('openai')
  expect(next.nativeSessionID).not.toBe(lease.nativeSessionID)
  expect(next.requireExisting).toBe(false)
  expect(next.initialContext.throughRunID).toBe(first.runID)
  expect(next.initialContext.turns).toHaveLength(1)
  expect(next.initialContext.turns[0]!.input.text).toBe(
    'Remember the conversation-only constraint: alpha.',
  )
  expect(next.initialContext.turns[0]!.output.text).toBe(
    'Completed first task; the constraint is alpha.',
  )
  expect(JSON.stringify(next.initialContext)).not.toContain('Continue only this new task.')
  const original = await db
    .selectFrom('execution.runs')
    .select(['model_call_count', 'deadline_at', 'status'])
    .where('run_id', '=', first.runID)
    .executeTakeFirstOrThrow()
  expect(original.model_call_count).toBe(1)
  expect(original.deadline_at?.getTime()).toBe(lease.deadlineAt.getTime())
  expect(original.status).toBe('completed')
})

async function started(engine: HarnessEngine = 'pi') {
  const command = await accept(thread(), 'Original bounded request.')
  const lease = await claimExecutionRun(db, {
    ownerID: 'context-boundary-worker',
    leaseMs: 60000,
    defaultEngine: engine,
  })
  if (lease === null || lease.runID !== command.runID) throw new Error('Expected original lease')
  const writes = bindExecutionWrites(db)
  expect(await writes.reserveModel(lease)).toBe('allowed')
  expect(await writes.checkpoint(lease)).toBe(true)
  return { command, lease, writes }
}

test('a retained initialized binding cannot switch after its source run has disappeared', async () => {
  const { lease, command, writes } = await started()
  expect(await writes.complete(lease, { text: 'Finished source.' })).toBe('completed')
  await db.deleteFrom('execution.event_outbox').where('run_id', '=', lease.runID).execute()
  await db.deleteFrom('execution.runs').where('run_id', '=', lease.runID).execute()
  await db
    .deleteFrom('execution.command_inbox')
    .where('command_id', '=', command.commandID)
    .execute()
  const next = await accept(lease.threadID, 'Fresh task after incomplete SQL history.')
  expect(
    await requestHarness(db, {
      threadID: lease.threadID,
      nativeSessionID: lease.nativeSessionID,
      engine: 'openai',
    }),
  ).toBe('accepted')
  await Promise.resolve(
    expect(
      claimExecutionRun(db, { ownerID: 'missing-source-worker', leaseMs: 60000 }),
    ).rejects.toThrow('Harness selection requires a completed native source'),
  )
  const run = await db
    .selectFrom('execution.runs')
    .select(['status', 'native_session_id', 'model_call_count'])
    .where('run_id', '=', next.runID)
    .executeTakeFirstOrThrow()
  expect(run).toEqual({ status: 'queued', native_session_id: null, model_call_count: 0 })
})

test('a negative selection snapshot cannot erase an intent accepted before the admission lock', async () => {
  const command = await accept(thread(), 'Unbound task.')
  const current = await db
    .selectFrom('execution.conversations')
    .select('native_session_id')
    .where('thread_id', '=', command.threadID)
    .executeTakeFirstOrThrow()
  const observed = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  let held = false
  // Delay the real SQL result, not the SQL operation or its side effects.
  const gated = db.withPlugin({
    transformQuery: (args) => args.node,
    async transformResult(args) {
      if (!held) {
        held = true
        expect(args.result.rows).toHaveLength(0)
        observed.resolve()
        await released.promise
      }
      return args.result
    },
  })
  const claiming = claimExecutionRun(gated, { ownerID: 'negative-snapshot-worker', leaseMs: 60000 })
  try {
    await observed.promise
    expect(
      await requestHarness(db, {
        threadID: command.threadID,
        nativeSessionID: current.native_session_id,
        engine: 'openai',
      }),
    ).toBe('accepted')
  } finally {
    released.resolve()
  }
  expect(await claiming).toBeNull()
  const pending = await db
    .selectFrom('execution.conversations')
    .selectAll()
    .where('thread_id', '=', command.threadID)
    .executeTakeFirstOrThrow()
  expect(pending.requested_engine).toBe('openai')
  expect(pending.harness_engine).toBeNull()
  const admitted = await claimExecutionRun(db, { ownerID: 'fresh-snapshot-worker', leaseMs: 60000 })
  expect(admitted?.runID).toBe(command.runID)
  expect(admitted?.engine).toBe('openai')
})

test('a pending target waits behind the original recovered run and preserves its accounting', async () => {
  const { lease, writes } = await started()
  const fresh = await accept(lease.threadID, 'Next independent task.')
  await recoverNativeRequests(db, async () => undefined)
  expect(
    await requestHarness(db, {
      threadID: lease.threadID,
      nativeSessionID: lease.nativeSessionID,
      engine: 'openai',
    }),
  ).toBe('accepted')
  const resumed = await claimExecutionRun(db, {
    ownerID: 'resuming-context-worker',
    leaseMs: 60000,
  })
  if (resumed === null) throw new Error('Expected original continuation')
  expect(resumed.runID).toBe(lease.runID)
  expect(resumed.nativeSessionID).toBe(lease.nativeSessionID)
  expect(resumed.engine).toBe('pi')
  expect(resumed.deadlineAt).toEqual(lease.deadlineAt)
  expect(resumed.restoring).toBe(true)
  expect(resumed.restoreWorkspace).toBe(true)
  const row = await db
    .selectFrom('execution.runs')
    .selectAll()
    .where('run_id', '=', lease.runID)
    .executeTakeFirstOrThrow()
  expect(row.model_call_count).toBe(1)
  expect(row.resume_count).toBe(1)
  expect(await writes.complete(resumed, { text: 'Original request settled.' })).toBe('completed')
  const switched = await claimExecutionRun(db, {
    ownerID: 'after-resume-worker',
    leaseMs: 60000,
    getCompleted: async () => ({ text: 'Original request settled.' }),
  })
  expect(switched?.runID).toBe(fresh.runID)
  expect(switched?.engine).toBe('openai')
  expect(switched?.nativeSessionID).not.toBe(lease.nativeSessionID)
})

test('ordinary admission never overwrites an inactive unresolved workspace transition', async () => {
  const command = await accept(thread(), 'Do not allocate around unresolved lifecycle state.')
  await db
    .updateTable('execution.conversations')
    .set({ workspace_transition_pending: true })
    .where('thread_id', '=', command.threadID)
    .execute()
  expect(
    await claimExecutionRun(db, { ownerID: 'unresolved-transition-worker', leaseMs: 60000 }),
  ).toBeNull()
  const conversation = await db
    .selectFrom('execution.conversations')
    .selectAll()
    .where('thread_id', '=', command.threadID)
    .executeTakeFirstOrThrow()
  expect(conversation.workspace_transition_pending).toBe(true)
  expect(conversation.active_run_id).toBeNull()
  const run = await db
    .selectFrom('execution.runs')
    .selectAll()
    .where('run_id', '=', command.runID)
    .executeTakeFirstOrThrow()
  expect(run.model_call_count).toBe(0)
  expect(run.native_session_id).toBeNull()
})

for (const engine of ['pi', 'openai'] as const) {
  test(`pending selection cannot bypass lost initialized ${engine} history`, async () => {
    const { lease, writes } = await started(engine)
    expect(
      await writes.complete(lease, { text: 'Business final is not a native checkpoint.' }),
    ).toBe('completed')
    const next = await accept(lease.threadID, 'Do not rebuild the original native state.')
    const target = engine === 'pi' ? 'openai' : 'pi'
    expect(
      await requestHarness(db, {
        threadID: lease.threadID,
        nativeSessionID: lease.nativeSessionID,
        engine: target,
      }),
    ).toBe('accepted')
    const directory = await mkdtemp(join(tmpdir(), 'context-source-loss-'))
    const options = {
      statePath: directory,
      baseURL: 'http://127.0.0.1:1',
      key: 'unused',
      modelID: 'unused',
      contextWindow: 10000,
      maxOutputTokens: 100,
      input: ['text'] as const,
      systemPrompt: 'unused',
    }
    const harness =
      engine === 'pi'
        ? createPiHarness({ ...options, reasoning: false })
        : createOpenAIHarness({ ...options, reasoning: null })
    try {
      await Promise.resolve(
        expect(
          claimExecutionRun(db, {
            ownerID: 'source-loss-worker',
            leaseMs: 60000,
            getCompleted: harness.completed,
          }),
        ).rejects.toThrow(),
      )
      const current = await db
        .selectFrom('execution.conversations')
        .selectAll()
        .where('thread_id', '=', lease.threadID)
        .executeTakeFirstOrThrow()
      expect(current.requested_engine).toBe(target)
      expect(current.native_session_id).toBe(lease.nativeSessionID)
      expect(current.active_run_id).toBeNull()
      expect(current.native_state_initialized).toBe(true)
      const run = await db
        .selectFrom('execution.runs')
        .selectAll()
        .where('run_id', '=', next.runID)
        .executeTakeFirstOrThrow()
      expect(run.status).toBe('queued')
      expect(run.model_call_count).toBe(0)
      expect(run.native_session_id).toBeNull()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
}

test('ordinary admission restores the current mirror from monotonic binding initialization proof', async () => {
  const { lease, writes } = await started()
  expect(await writes.complete(lease, { text: 'Original completed turn.' })).toBe('completed')
  await db
    .updateTable('execution.conversations')
    .set({ native_state_initialized: false })
    .where('thread_id', '=', lease.threadID)
    .execute()
  const next = await accept(lease.threadID, 'Ordinary next task.')
  const assigned = await claimExecutionRun(db, {
    ownerID: 'monotonic-mirror-worker',
    leaseMs: 60000,
  })
  expect(assigned?.runID).toBe(next.runID)
  expect(assigned?.requireExisting).toBe(true)
  expect(
    (
      await db
        .selectFrom('execution.conversations')
        .select('native_state_initialized')
        .where('thread_id', '=', lease.threadID)
        .executeTakeFirstOrThrow()
    ).native_state_initialized,
  ).toBe(true)
})

test('initialized binding proof cannot be weakened by an outdated conversation mirror', async () => {
  const { lease, writes } = await started('openai')
  expect(await writes.complete(lease, { text: 'Retained final.' })).toBe('completed')
  await db
    .updateTable('execution.conversations')
    .set({ native_state_initialized: false })
    .where('thread_id', '=', lease.threadID)
    .execute()
  await accept(lease.threadID, 'The final receipt is not the missing Session history.')
  expect(
    await requestHarness(db, {
      threadID: lease.threadID,
      nativeSessionID: lease.nativeSessionID,
      engine: 'pi',
    }),
  ).toBe('accepted')
  const directory = await mkdtemp(join(tmpdir(), 'context-mirror-loss-'))
  try {
    // Controlled envelope fixture: completed lookup does not decode SDK state.
    await writeJSON(join(directory, 'openai', lease.threadID, 'runs', `${lease.runID}.json`), {
      nativeSessionID: lease.nativeSessionID,
      state: 'unused opaque fixture',
      sources: [],
      assets: [],
      completion: { text: 'Retained final.' },
    })
    const harness = createOpenAIHarness({
      statePath: directory,
      baseURL: 'http://127.0.0.1:1',
      key: 'unused',
      modelID: 'unused',
      contextWindow: 10000,
      maxOutputTokens: 100,
      input: ['text'],
      systemPrompt: 'unused',
      reasoning: null,
    })
    await Promise.resolve(
      expect(
        claimExecutionRun(db, {
          ownerID: 'mirror-loss-worker',
          leaseMs: 60000,
          getCompleted: harness.completed,
        }),
      ).rejects.toThrow(),
    )
    expect(
      (
        await db
          .selectFrom('execution.conversations')
          .select('native_session_id')
          .where('thread_id', '=', lease.threadID)
          .executeTakeFirstOrThrow()
      ).native_session_id,
    ).toBe(lease.nativeSessionID)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('Pi OpenAI Pi bindings retain old lookup and reject rewriting an accepted identity', async () => {
  const { lease, writes } = await started()
  expect(await writes.complete(lease, { text: 'First completed turn.' })).toBe('completed')
  await accept(lease.threadID, 'Second input.')
  expect(
    await requestHarness(db, {
      threadID: lease.threadID,
      nativeSessionID: lease.nativeSessionID,
      engine: 'openai',
    }),
  ).toBe('accepted')
  expect(
    await requestHarness(db, {
      threadID: lease.threadID,
      nativeSessionID: lease.nativeSessionID,
      engine: 'openai',
    }),
  ).toBe('replay')
  await Promise.resolve(
    expect(
      requestHarness(db, {
        threadID: lease.threadID,
        nativeSessionID: lease.nativeSessionID,
        engine: 'pi',
      }),
    ).rejects.toThrow('pending selection'),
  )
  const second = await claimExecutionRun(db, {
    ownerID: 'second-binding-worker',
    leaseMs: 60000,
    getCompleted: async () => ({ text: 'First completed turn.' }),
  })
  if (second === null) throw new Error('Expected second binding')
  expect(second.nativeSessionStorage).toBe('session')
  expect(await writes.checkpoint(second)).toBe(true)
  expect(await writes.complete(second, { text: 'Second completed turn.' })).toBe('completed')
  await accept(lease.threadID, 'Third input.')
  expect(
    await requestHarness(db, {
      threadID: lease.threadID,
      nativeSessionID: second.nativeSessionID,
      engine: 'pi',
    }),
  ).toBe('accepted')
  const third = await claimExecutionRun(db, {
    ownerID: 'third-binding-worker',
    leaseMs: 60000,
    getCompleted: async () => ({ text: 'Second completed turn.' }),
  })
  if (third === null || third.initialContext === undefined)
    throw new Error('Expected third binding context')
  expect(third.engine).toBe('pi')
  expect(third.nativeSessionID).not.toBe(lease.nativeSessionID)
  expect(third.nativeSessionID).not.toBe(second.nativeSessionID)
  expect(third.initialContext.turns.map((turn) => turn.output.text)).toEqual([
    'First completed turn.',
    'Second completed turn.',
  ])
  expect(third.initialContext.throughRunID).toBe(second.runID)
  expect(
    await readNativeRequestIdentity(db, { threadID: lease.threadID, runID: lease.runID }),
  ).toEqual({
    threadID: lease.threadID,
    runID: lease.runID,
    engine: 'pi',
    nativeSessionID: lease.nativeSessionID,
    nativeSessionStorage: 'legacy',
    requireExisting: true,
  })
  expect(
    await readNativeRequestIdentity(db, { threadID: lease.threadID, runID: second.runID }),
  ).toEqual({
    threadID: lease.threadID,
    runID: second.runID,
    engine: 'openai',
    nativeSessionID: second.nativeSessionID,
    nativeSessionStorage: 'session',
    requireExisting: true,
  })
  await Promise.resolve(
    expect(
      db
        .updateTable('execution.runs')
        .set({ native_session_id: third.nativeSessionID })
        .where('run_id', '=', lease.runID)
        .execute(),
    ).rejects.toThrow('Accepted native session binding is immutable'),
  )
})

test('native validation cannot admit work after source fence changes while IO is outside SQL locks', async () => {
  const { lease, writes } = await started()
  expect(await writes.complete(lease, { text: 'Completed source.' })).toBe('completed')
  const next = await accept(lease.threadID, 'New input.')
  expect(
    await requestHarness(db, {
      threadID: lease.threadID,
      nativeSessionID: lease.nativeSessionID,
      engine: 'openai',
    }),
  ).toBe('accepted')
  await Promise.resolve(
    expect(
      claimExecutionRun(db, {
        ownerID: 'changed-source-worker',
        leaseMs: 60000,
        getCompleted: async () => {
          // This update would deadlock if native IO retained a conversation lock.
          await db
            .updateTable('execution.conversations')
            .set({ fence: lease.fence + 1 })
            .where('thread_id', '=', lease.threadID)
            .execute()
          return { text: 'Completed source.' }
        },
      }),
    ).rejects.toThrow('source changed before admission'),
  )
  const row = await db
    .selectFrom('execution.runs')
    .selectAll()
    .where('run_id', '=', next.runID)
    .executeTakeFirstOrThrow()
  expect(row.native_session_id).toBeNull()
  expect(row.model_call_count).toBe(0)
  expect(row.status).toBe('queued')
  expect(
    (
      await db
        .selectFrom('execution.conversations')
        .select('requested_engine')
        .where('thread_id', '=', lease.threadID)
        .executeTakeFirstOrThrow()
    ).requested_engine,
  ).toBe('openai')
})
