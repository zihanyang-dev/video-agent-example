import { afterAll, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'kysely'
import type { StartCommand } from '@vid/contract/execution'
import { acceptExecutionCommand } from '../../apps/agent/src/execution/db/command-acceptance'
import {
  claimExecutionRun,
  recoverNativeRequests,
} from '../../apps/agent/src/execution/db/execution-leases'
import { bindExecutionWrites } from '../../apps/agent/src/execution/db/run-writes'
import {
  createOpenAIHarness,
  type OpenAIHarnessOptions,
} from '../../apps/agent/src/harness/openai/adapter'
import { clearOwnedExecutionThread, openTestDatabase, settleTestCleanup } from './database-fixture'

const { db, close } = openTestDatabase()
const threads: string[] = []
afterAll(async () => {
  await settleTestCleanup([
    ...threads.map((threadID) => () => clearOwnedExecutionThread(db, threadID)),
    close,
  ])
})
async function accepted(threadID: string = crypto.randomUUID()) {
  if (!threads.includes(threadID)) threads.push(threadID)
  const command: StartCommand = {
    version: 1,
    kind: 'start',
    commandID: crypto.randomUUID(),
    threadID,
    runID: crypto.randomUUID(),
    input: { messageID: crypto.randomUUID(), text: 'Continue native history' },
  }
  expect(await acceptExecutionCommand(db, command)).toBe('accepted')
  return command
}
const writes = bindExecutionWrites(db)
const claim = (engine: 'pi' | 'openai' = 'openai') =>
  claimExecutionRun(db, { ownerID: 'native-loss-worker', leaseMs: 60000, defaultEngine: engine })
const conversation = (threadID: string) =>
  db
    .selectFrom('execution.conversations')
    .selectAll()
    .where('thread_id', '=', threadID)
    .executeTakeFirstOrThrow()

test('engine allocation does not initialize native history; only a live owner checkpoint does', async () => {
  const command = await accepted()
  const lease = await claim()
  if (!lease || lease.runID !== command.runID) throw new Error('Expected assigned request')
  expect(lease.requireExisting).toBe(false)
  expect((await conversation(command.threadID)).native_state_initialized).toBe(false)
  expect(await writes.checkpoint({ ...lease, fence: lease.fence + 1 })).toBe(false)
  expect(await writes.checkpoint({ ...lease, ownerID: 'other' })).toBe(false)
  expect((await conversation(command.threadID)).native_state_initialized).toBe(false)
  await db
    .updateTable('execution.conversations')
    .set({ lease_until: new Date(0) })
    .where('thread_id', '=', command.threadID)
    .execute()
  expect(await writes.checkpoint(lease)).toBe(false)
  expect((await conversation(command.threadID)).native_state_initialized).toBe(false)
  // An allocated engine may fail configuration before opening any SDK state.
  await db
    .updateTable('execution.conversations')
    .set({ lease_until: new Date(Date.now() + 60000) })
    .where('thread_id', '=', command.threadID)
    .execute()
  expect(await writes.fail(lease, 'execution-error')).toBe('failed')
  await accepted(command.threadID)
  const next = await claim('pi')
  expect(next?.engine).toBe('openai')
  expect(next?.nativeSessionID).toBe(lease.nativeSessionID)
  expect(next?.requireExisting).toBe(false)
  if (!next) throw new Error('Expected next request')
  expect(await writes.checkpoint(next)).toBe(true)
  expect((await conversation(command.threadID)).native_state_initialized).toBe(true)
  await writes.fail(next, 'execution-error')
})

test('lost initialized SDK history blocks startup and same-ID next turn without changing SQL authority or budgets', async () => {
  const command = await accepted()
  const lease = await claim()
  if (!lease || lease.runID !== command.runID) throw new Error('Expected assigned request')
  const statePath = await mkdtemp(join(tmpdir(), 'sql-native-loss-'))
  try {
    let models = 0
    let tools = 0
    const model: NonNullable<OpenAIHarnessOptions['model']> = {
      async getResponse() {
        throw new Error('Unexpected nonstream call')
      },
      async *getStreamedResponse() {
        models++
        yield {
          type: 'response_done',
          response: {
            id: 'fixture',
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            output: [
              {
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text: 'done' }],
              },
            ],
          },
        }
      },
    }
    const harness = createOpenAIHarness({
      statePath,
      model,
      modelID: 'fixture',
      baseURL: 'http://127.0.0.1:1',
      key: 'fixture',
      contextWindow: 10000,
      maxOutputTokens: 100,
      reasoning: 'low',
      input: ['text'],
      systemPrompt: 'fixture',
    })
    const input = {
      ...lease,
      signal: new AbortController().signal,
      tools: {
        execute: async () => {
          tools++
          return { stdout: '', stderr: '', exitCode: 0 }
        },
        read: async () => {
          tools++
          return ''
        },
        write: async () => {
          tools++
        },
      },
      onText: () => {},
      beforeModel: async () => {
        expect(await writes.reserveModel(lease)).toBe('allowed')
      },
      checkpoint: async () => {
        expect(await writes.checkpoint(lease)).toBe(true)
      },
    }
    expect((await harness.run(input)).text).toBe('done')
    expect((await conversation(command.threadID)).native_state_initialized).toBe(true)
    const beforeConversation = await conversation(command.threadID)
    const beforeRun = await db
      .selectFrom('execution.runs')
      .selectAll()
      .where('run_id', '=', lease.runID)
      .executeTakeFirstOrThrow()
    await rm(join(statePath, 'openai', lease.threadID, 'session.json'))
    // Mirrors startup's exclusive kernel-lock admission: the read-only callback
    // must throw before SQL releases/requeues an owner or reconciles a final.
    await Promise.resolve(
      expect(recoverNativeRequests(db, harness.completed)).rejects.toThrow('Native state lost'),
    )
    expect(await conversation(command.threadID)).toEqual(beforeConversation)
    expect(
      await db
        .selectFrom('execution.runs')
        .selectAll()
        .where('run_id', '=', lease.runID)
        .executeTakeFirstOrThrow(),
    ).toEqual(beforeRun)
    expect(await writes.fail(lease, 'execution-error')).toBe('failed')
    await accepted(command.threadID)
    const next = await claim('pi')
    if (!next) throw new Error('Expected next request')
    expect(next.engine).toBe('openai')
    expect(next.nativeSessionID).toBe(lease.nativeSessionID)
    expect(next.requireExisting).toBe(true)
    const beforeNext = await conversation(command.threadID)
    await Promise.resolve(
      expect(harness.run({ ...input, ...next })).rejects.toThrow('Native state lost'),
    )
    expect(await conversation(command.threadID)).toEqual(beforeNext)
    expect(models).toBe(1)
    expect(tools).toBe(0)
    expect(beforeRun.model_call_count).toBe(1)
    expect((await conversation(command.threadID)).sandbox_recovery_required).toBe(false)
    await writes.fail(next, 'execution-error')
  } finally {
    await rm(statePath, { recursive: true, force: true })
  }
})

test('forward migration backfills only nonlegacy native identities with model reservation evidence', async () => {
  const commands = [await accepted(), await accepted(), await accepted()]
  const migration = await readFile(
    new URL(
      '../../packages/database/migrations/20261007010000_native_state_initialized.sql',
      import.meta.url,
    ),
    'utf8',
  )
  const update = migration.match(/UPDATE execution\.conversations[\s\S]*?;/)?.[0]
  if (!update) throw new Error('Expected forward migration backfill')
  const rollback = new Error('Rollback migration fixture')
  try {
    await db.transaction().execute(async (tx) => {
      for (const [index, command] of commands.entries()) {
        await tx
          .updateTable('execution.conversations')
          .set({
            harness_engine: 'openai',
            native_state_initialized: false,
            legacy_import_required: index === 2,
          })
          .where('thread_id', '=', command.threadID)
          .execute()
        await tx
          .updateTable('execution.runs')
          .set({ model_call_count: index === 0 ? 0 : 1 })
          .where('run_id', '=', command.runID)
          .execute()
      }
      await sql.raw(update).execute(tx)
      for (const [index, command] of commands.entries()) {
        const row = await tx
          .selectFrom('execution.conversations')
          .select('native_state_initialized')
          .where('thread_id', '=', command.threadID)
          .executeTakeFirstOrThrow()
        expect(row.native_state_initialized).toBe(index === 1)
      }
      throw rollback
    })
  } catch (error) {
    if (error !== rollback) throw error
  } finally {
    for (const command of commands)
      await db
        .updateTable('execution.runs')
        .set({ status: 'failed' })
        .where('run_id', '=', command.runID)
        .execute()
  }
})
