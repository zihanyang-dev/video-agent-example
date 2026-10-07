import { webSourcesSchema } from '@vid/contract/web-source'
import { publicAsset } from './assets'
import { acceptedStartIdentity } from './accepted-start'
import type { DB } from '@vid/database/types'
import { executionEventSchema } from '@vid/contract/execution'
import {
  publicUUIDSchema,
  type PublicThread,
  type ActiveRun,
  type MessagesResponse,
  type PublicAsset,
} from '@vid/contract/http'
import { sql, type Kysely } from 'kysely'
import type { OwnedThread } from '../conversation/submission'
import { lockThread, threadUnavailable, threadConflict } from './thread-access'

export function publicThread(thread: {
  thread_id: string
  title: string
  created_at: Date
  archived_at: Date | null
}): PublicThread {
  return {
    threadID: thread.thread_id,
    title: thread.title,
    createdAt: thread.created_at.toISOString(),
    archivedAt: thread.archived_at?.toISOString() ?? null,
  }
}

export async function readOwnedThread(db: Kysely<DB>, query: OwnedThread) {
  const thread = await db
    .selectFrom('product.threads')
    .selectAll()
    .where('thread_id', '=', query.threadID)
    .where('owner_id', '=', query.ownerID)
    .executeTakeFirst()
  return thread ? publicThread(thread) : undefined
}

export async function listOwnedThreads(db: Kysely<DB>, ownerID: string) {
  const threads = await db
    .selectFrom('product.threads')
    .selectAll()
    .where('owner_id', '=', ownerID)
    .orderBy('created_at')
    .orderBy('thread_id')
    .execute()
  return threads.map(publicThread)
}

/** Stable client ID and immutable creation title define retry identity. The
 * global UUID collision cannot disclose a foreign thread or overwrite it. */
export async function createOwnedThread(db: Kysely<DB>, input: OwnedThread & { title: string }) {
  return await db.transaction().execute(async (tx) => {
    const inserted = await tx
      .insertInto('product.threads')
      .values({
        thread_id: input.threadID,
        owner_id: input.ownerID,
        title: input.title,
        creation_title: input.title,
      })
      .onConflict((c) => c.doNothing())
      .returning('thread_id')
      .executeTakeFirst()
    const thread = await lockThread(tx, input, 'read')
    if (thread.creation_title !== input.title) throw threadConflict
    return { thread: publicThread(thread), created: inserted !== undefined }
  })
}

export async function updateOwnedThread(db: Kysely<DB>, input: OwnedThread & { title: string }) {
  return await db.transaction().execute(async (tx) => {
    await lockThread(tx, input, 'write')
    const thread = await tx
      .updateTable('product.threads')
      .set({ title: input.title })
      .where('thread_id', '=', input.threadID)
      .returningAll()
      .executeTakeFirstOrThrow()
    return publicThread(thread)
  })
}

export async function snapshotOwnedMessages(db: Kysely<DB>, query: OwnedThread) {
  try {
    return await db.transaction().execute(async (tx) => {
      await lockThread(tx, query, 'read')
      const rows = await tx
        .selectFrom('product.messages')
        .select(['message_id', 'role', 'text', 'created_at', 'sources'])
        .where('thread_id', '=', query.threadID)
        .orderBy('created_at')
        .orderBy('message_id')
        .execute()
      const links = await tx
        .selectFrom('product.message_assets as link')
        .innerJoin('product.assets as asset', (join) =>
          join
            .onRef('asset.asset_id', '=', 'link.asset_id')
            .onRef('asset.thread_id', '=', 'link.thread_id'),
        )
        .selectAll('asset')
        .select('link.message_id as linked_message_id')
        .where('link.thread_id', '=', query.threadID)
        .orderBy('link.message_id')
        .orderBy('link.position')
        .execute()
      const assetsByMessage = new Map<string, PublicAsset[]>()
      for (const link of links) {
        const assets = assetsByMessage.get(link.linked_message_id) ?? []
        assets.push(publicAsset(link))
        assetsByMessage.set(link.linked_message_id, assets)
      }
      // Terminals are canonical on receipt, even before ordinal gaps permit SSE
      // publication. Read the existing ledger, not observer or worker state.
      const terminals = await tx
        .selectFrom('product.command_outbox as start')
        .innerJoin('product.execution_events as terminal', (join) =>
          join
            .onRef('terminal.thread_id', '=', 'start.thread_id')
            .onRef('terminal.run_id', '=', 'start.run_id'),
        )
        .innerJoin('product.messages as input', (join) =>
          join
            .onRef('input.thread_id', '=', 'start.thread_id')
            .onRef('input.message_id', '=', 'start.message_id'),
        )
        .select(['start.run_id', 'input.message_id'])
        // Completion payloads can contain large text already read above. Transfer
        // only their product identity; failures retain strict envelope validation.
        .select(sql<string>`terminal.payload ->> 'kind'`.as('kind'))
        .select(sql<unknown>`terminal.payload -> 'messageID'`.as('output_message_id'))
        .select(
          sql<unknown>`case when terminal.payload ->> 'kind' = 'run-failed' then terminal.payload end`.as(
            'failure_payload',
          ),
        )
        .where('start.thread_id', '=', query.threadID)
        .where('input.role', '=', 'user')
        .where(acceptedStartIdentity())
        .where(sql<string>`terminal.payload ->> 'kind'`, 'in', [
          'run-completed',
          'run-cancelled',
          'run-failed',
        ])
        .orderBy('start.created_at')
        .orderBy('start.run_id')
        .execute()
      const outcomes = new Map<string, { runID: string; status: 'completed' | 'cancelled' }>()
      for (const terminal of terminals) {
        if (terminal.kind !== 'run-completed') continue
        const messageID = publicUUIDSchema.parse(terminal.output_message_id)
        outcomes.set(messageID, { runID: terminal.run_id, status: 'completed' })
      }
      for (const terminal of terminals) {
        if (terminal.kind !== 'run-cancelled') continue
        outcomes.set(terminal.message_id, {
          runID: terminal.run_id,
          status: 'cancelled',
        })
      }
      const messages = rows.map((message) => {
        const runOutcome = outcomes.get(message.message_id)
        return {
          messageID: message.message_id,
          role: message.role,
          text: message.text,
          sources: [...webSourcesSchema.parse(message.sources)],
          ...(runOutcome === undefined ? {} : { runOutcome }),
          createdAt: message.created_at.toISOString(),
          assets: assetsByMessage.get(message.message_id) ?? [],
        }
      })
      return {
        messages,
        activeRuns: await readActiveRuns(tx, query.threadID),
        failedRuns: terminals
          .filter((terminal) => terminal.kind === 'run-failed')
          .map((failure) => {
            const event = executionEventSchema.parse(failure.failure_payload)
            if (event.kind !== 'run-failed') throw new Error('Expected a durable run failure')
            return {
              runID: failure.run_id,
              messageID: failure.message_id,
              reason: event.reason,
            }
          }),
      } satisfies MessagesResponse
    })
  } catch (cause) {
    if (cause === threadUnavailable) return null
    throw cause
  }
}

/** Accepted commands and public receipts, never worker lease state, supply the
 * reload view. Stop requests stay active until a durable terminal arrives. */
export async function readActiveRuns(db: Kysely<DB>, threadID: string): Promise<ActiveRun[]> {
  const runs = await db
    .selectFrom('product.command_outbox as start')
    .select(['start.run_id', 'start.message_id'])
    .select(
      sql<boolean>`exists (
        select 1 from product.command_outbox c
        where c.run_id = start.run_id and c.thread_id = start.thread_id
          and c.message_id is null
          and c.command ->> 'kind' = 'cancel'
          and c.command -> 'version' = '1'::jsonb
          and lower(c.command ->> 'threadID') = c.thread_id::text
          and lower(c.command ->> 'runID') = c.run_id::text
          and lower(c.command ->> 'commandID') = c.command_id::text
      )`.as('is_stopping'),
    )
    .select(
      sql<boolean>`exists (
        select 1 from product.execution_events e
        where e.run_id = start.run_id and e.thread_id = start.thread_id
          and e.payload ->> 'kind' = 'run-started'
      )`.as('is_running'),
    )
    .where('start.thread_id', '=', threadID)
    .where(acceptedStartIdentity())
    .where(
      sql<boolean>`not exists (
        select 1 from product.execution_events e
        where e.run_id = start.run_id and e.thread_id = start.thread_id
          and e.payload ->> 'kind' in ('run-completed','run-cancelled','run-failed')
      )`,
    )
    .orderBy('start.created_at')
    .execute()
  return runs.map((run) => {
    if (!run.message_id) throw new Error('Accepted start lacks message identity')
    let status: ActiveRun['status'] = 'accepted'
    if (run.is_running) status = 'running'
    if (run.is_stopping) status = 'stopping'
    return { runID: run.run_id, messageID: run.message_id, status }
  })
}
