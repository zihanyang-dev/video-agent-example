import { afterAll, expect, test } from 'bun:test'
import { executionEventSchema } from '@vid/contract/execution'
import { publicMessageSchema } from '@vid/contract/http'
import { acceptExecutionCommand } from '../../apps/agent/src/db/command-acceptance'
import { claimExecutionRun } from '../../apps/agent/src/db/execution-leases'
import { bindExecutionWrites } from '../../apps/agent/src/db/run-writes'
import { executeRun } from '../../apps/agent/src/execute-run'
import { createPiHarness } from '../../apps/agent/src/harness/pi'
import { acceptExecutionEvent } from '../../apps/server/src/db/execution-events'
import { snapshotOwnedMessages } from '../../apps/server/src/db/conversations'
import { acceptMessageIntent } from '../../apps/server/src/db/submissions'
import { openTestDatabase, seedTestUser } from './database-fixture'

const { db, close } = openTestDatabase()
const threads: string[] = []
const ownerID = `sources-${crypto.randomUUID()}`
afterAll(async () => {
  try {
    for (const threadID of threads) {
      await db
        .updateTable('execution.conversations')
        .set({ active_run_id: null, lease_owner: null, lease_until: null })
        .where('thread_id', '=', threadID)
        .execute()
      await db
        .deleteFrom('execution.event_outbox')
        .where('thread_id', '=', threadID)
        .execute()
      await db
        .deleteFrom('execution.runs')
        .where('thread_id', '=', threadID)
        .execute()
      await db
        .deleteFrom('execution.command_inbox')
        .where('thread_id', '=', threadID)
        .execute()
      await db
        .deleteFrom('execution.conversations')
        .where('thread_id', '=', threadID)
        .execute()
      await db
        .deleteFrom('product.execution_events')
        .where('thread_id', '=', threadID)
        .execute()
      await db
        .deleteFrom('product.command_outbox')
        .where('thread_id', '=', threadID)
        .execute()
      await db
        .deleteFrom('product.messages')
        .where('thread_id', '=', threadID)
        .execute()
      await db
        .deleteFrom('product.threads')
        .where('thread_id', '=', threadID)
        .execute()
    }
    await db.deleteFrom('auth.user').where('id', '=', ownerID).execute()
  } finally {
    await close()
  }
})

async function fixture() {
  const intent = {
    ownerID,
    threadID: crypto.randomUUID(),
    runID: crypto.randomUUID(),
    commandID: crypto.randomUUID(),
    messageID: crypto.randomUUID(),
    text: 'PRIVATE USER INPUT',
  }
  await seedTestUser(db, ownerID)
  await db
    .insertInto('product.threads')
    .values({ thread_id: intent.threadID, owner_id: ownerID })
    .execute()
  threads.push(intent.threadID)
  await acceptMessageIntent(db, intent)
  return intent
}

// Real native Pi tool/model HTTP loopback -> execution SQL outbox -> canonical
// server receipt/message transaction -> whitelist snapshot. No external API.
test('actual native sources survive canonical completion SQL and immutable snapshot without private evidence', async () => {
  const intent = await fixture()
  const command = {
    version: 1,
    kind: 'start',
    commandID: intent.commandID,
    threadID: intent.threadID,
    runID: intent.runID,
    input: { messageID: intent.messageID, text: intent.text },
  } as const
  await acceptExecutionCommand(db, command)
  const lease = await claimExecutionRun(db, {
    ownerID: 'sources-worker',
    leaseMs: 10000,
  })
  if (!lease || lease.runID !== intent.runID)
    throw new Error('Expected assigned lease')
  let requests = 0
  const model = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      await request.json()
      requests++
      const delta =
        requests === 1
          ? {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'search',
                  type: 'function',
                  function: {
                    name: 'web_search',
                    arguments: JSON.stringify({
                      query: 'PRIVATE QUERY CANARY',
                    }),
                  },
                },
              ],
            }
          : {
              role: 'assistant',
              content: 'Final answer',
              reasoning_content: 'PRIVATE COT CANARY',
            }
      const chunks = [
        { delta, finish_reason: null },
        { delta: {}, finish_reason: requests === 1 ? 'tool_calls' : 'stop' },
      ]
      return new Response(
        chunks
          .map(
            (chunk) =>
              `data: ${JSON.stringify({ id: 'fixture', model: 'fixture', choices: [{ index: 0, ...chunk }] })}\n\n`,
          )
          .join('') + 'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      )
    },
  })
  const sources = [
    { title: 'Public source', url: 'https://example.org/source' },
  ]
  try {
    const outcome = await executeRun(
      lease,
      {
        writes: bindExecutionWrites(db),
        harness: createPiHarness({
          baseURL: `http://127.0.0.1:${model.port}/v1`,
          key: 'PRIVATE MODEL KEY',
          modelID: 'fixture',
          contextWindow: 8192,
          maxOutputTokens: 512,
          reasoning: true,
          input: ['text'],
          systemPrompt: 'PRIVATE SYSTEM',
          webSearch: {
            authMode: 'key',
            apiKey: 'PRIVATE SEARCH KEY',
            transport: async () =>
              Response.json({
                results: [{ ...sources[0], content: 'PRIVATE SNIPPET CANARY' }],
              }),
          },
        }),
        openSandbox: async () => ({
          nativeRef: { provider: 'e2b', id: 'fixture' },
          close: async () => {},
          readBytes: async () => new Uint8Array(),
          writeBytes: async () => {},
          execute: async () => {
            throw new Error('Unexpected tool')
          },
          read: async () => {
            throw new Error('Unexpected tool')
          },
          write: async () => {
            throw new Error('Unexpected tool')
          },
        }),
      },
      { leaseMs: 10000, pollMs: 100, signal: AbortSignal.timeout(5000) },
    )
    expect(outcome).toBe('completed')
    const outbox = await db
      .selectFrom('execution.event_outbox')
      .select(['event', 'ordinal'])
      .where('run_id', '=', intent.runID)
      .orderBy('ordinal')
      .execute()
    const completed = outbox
      .map((row) => executionEventSchema.parse(row.event))
      .find((event) => event.kind === 'run-completed')
    if (!completed || completed.kind !== 'run-completed')
      throw new Error('Missing completion')
    expect(completed.sources).toEqual(sources)
    expect(JSON.stringify(completed)).not.toContain('PRIVATE')
    for (const row of outbox)
      expect(
        await acceptExecutionEvent(db, {
          event: executionEventSchema.parse(row.event),
          ordinal: Number(row.ordinal),
        }),
      ).toBe('accepted')
    const snapshot = await snapshotOwnedMessages(db, intent)
    const final = snapshot?.messages.find(
      (message) => message.role === 'assistant',
    )
    expect(final).toMatchObject({ text: 'Final answer', sources })
    expect(publicMessageSchema.safeParse(final).success).toBe(true)
    expect(JSON.stringify(final)).not.toContain('PRIVATE')
    expect(Object.keys(final ?? {}).sort()).toEqual([
      'assets',
      'createdAt',
      'messageID',
      'role',
      'runOutcome',
      'sources',
      'text',
    ])
    const stored = await db
      .selectFrom('product.messages')
      .select('sources')
      .where('message_id', '=', completed.messageID)
      .executeTakeFirstOrThrow()
    expect(stored.sources).toEqual(sources)
    const delivery = {
      event: completed,
      ordinal: Number(outbox.at(-1)!.ordinal),
    }
    expect(await acceptExecutionEvent(db, delivery)).toBe('accepted')
    expect(
      await acceptExecutionEvent(db, {
        ...delivery,
        event: {
          ...completed,
          sources: [{ title: 'Changed', url: 'https://example.org/changed' }],
        },
      }),
    ).toBe('conflict')
    expect(
      (
        await db
          .selectFrom('product.messages')
          .select('sources')
          .where('message_id', '=', completed.messageID)
          .executeTakeFirstOrThrow()
      ).sources,
    ).toEqual(sources)
    const history = await db
      .selectFrom('execution.conversations')
      .select('history')
      .where('thread_id', '=', intent.threadID)
      .executeTakeFirstOrThrow()
    expect(JSON.stringify(history.history)).toContain('PRIVATE SNIPPET CANARY')
  } finally {
    await model.stop(true)
  }
}, 15000)

test('historical messages default to no sources; unknown completion and cancellation never publish sources', async () => {
  const intent = await fixture()
  const identities = {
    version: 1,
    threadID: intent.threadID,
    runID: intent.runID,
    eventID: crypto.randomUUID(),
  } as const
  expect(
    await acceptExecutionEvent(db, {
      ordinal: 1,
      event: {
        ...identities,
        runID: crypto.randomUUID(),
        kind: 'run-completed',
        messageID: crypto.randomUUID(),
        text: 'Not authorized',
        sources: [{ title: 'Found', url: 'https://example.org/' }],
      },
    }),
  ).toBe('unknown-run')
  expect(
    await acceptExecutionEvent(db, {
      ordinal: 1,
      event: { ...identities, kind: 'run-cancelled' },
    }),
  ).toBe('accepted')
  const snapshot = await snapshotOwnedMessages(db, intent)
  expect(snapshot?.messages).toHaveLength(1)
  expect(snapshot?.messages[0]).toMatchObject({ role: 'user', sources: [] })
})
