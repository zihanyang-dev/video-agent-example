import { messageAssets, publicAsset } from './assets'
import type { DB } from '@vid/database/types'
import { executionEventSchema } from '@vid/contract/execution'
import type {
  PublicThread,
  ActiveRun,
  MessagesResponse,
} from '@vid/contract/http'
import { sql, type Kysely } from 'kysely'
import type { OwnedThread } from '../conversation/submission'
import {
  lockThread,
  threadUnavailable,
  threadConflict,
  legacyOwnershipUnmapped,
} from './thread-access'

/** Auth stays available while administrators review legacy owners. Product
 * routes fail explicitly instead of silently hiding history or letting the
 * first login claim it. No string comparison can replace that review. */
export async function requireMappedOwnership(db: Kysely<DB>) {
  const legacy = await db
    .selectFrom('product.threads')
    .select('thread_id')
    .where('owner_id', 'is', null)
    .limit(1)
    .executeTakeFirst()
  if (legacy) throw legacyOwnershipUnmapped
}

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
export async function createOwnedThread(
  db: Kysely<DB>,
  input: OwnedThread & { title: string },
) {
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

export async function updateOwnedThread(
  db: Kysely<DB>,
  input: OwnedThread & { title: string },
) {
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

export async function snapshotOwnedMessages(
  db: Kysely<DB>,
  query: OwnedThread,
) {
  try {
    return await db.transaction().execute(async (tx) => {
      await lockThread(tx, query, 'read')
      const rows = await tx
        .selectFrom('product.messages')
        .select(['message_id', 'role', 'text', 'created_at'])
        .where('thread_id', '=', query.threadID)
        .orderBy('created_at')
        .orderBy('message_id')
        .execute()
      const messages = await Promise.all(
        rows.map(async (message) => ({
          messageID: message.message_id,
          role: message.role,
          text: message.text,
          createdAt: message.created_at.toISOString(),
          assets: (await messageAssets(tx, message.message_id)).map(
            publicAsset,
          ),
        })),
      )
      // Terminals are canonical on receipt, even before ordinal gaps permit SSE
      // publication. Read the existing ledger, not observer or worker state.
      const failures = await tx
        .selectFrom('product.command_outbox as start')
        .innerJoin('product.execution_events as failure', (join) =>
          join
            .onRef('failure.thread_id', '=', 'start.thread_id')
            .onRef('failure.run_id', '=', 'start.run_id'),
        )
        .innerJoin('product.messages as input', (join) =>
          join
            .onRef('input.thread_id', '=', 'start.thread_id')
            .onRef('input.message_id', '=', 'start.message_id'),
        )
        .select(['start.run_id', 'input.message_id', 'failure.payload'])
        .where('start.thread_id', '=', query.threadID)
        .where('input.role', '=', 'user')
        .where(sql<string>`start.command ->> 'kind'`, '=', 'start')
        .where(sql<string>`start.command ->> 'version'`, '=', '1')
        .where(
          sql<boolean>`lower(start.command ->> 'threadID') = start.thread_id::text`,
        )
        .where(
          sql<boolean>`lower(start.command ->> 'runID') = start.run_id::text`,
        )
        .where(
          sql<boolean>`lower(start.command ->> 'commandID') = start.command_id::text`,
        )
        .where(
          sql<boolean>`lower(start.command #>> '{input,messageID}') = start.message_id::text`,
        )
        .where(sql<string>`failure.payload ->> 'kind'`, '=', 'run-failed')
        .orderBy('start.created_at')
        .orderBy('start.run_id')
        .execute()
      return {
        messages,
        activeRuns: await readActiveRuns(tx, query.threadID),
        failedRuns: failures.map((failure) => {
          const event = executionEventSchema.parse(failure.payload)
          if (event.kind !== 'run-failed')
            throw new Error('Expected a durable run failure')
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
export async function readActiveRuns(
  db: Kysely<DB>,
  threadID: string,
): Promise<ActiveRun[]> {
  const runs = await db
    .selectFrom('product.command_outbox as start')
    .select(['start.run_id', 'start.message_id'])
    .select(
      sql<boolean>`exists (select 1 from product.command_outbox c where c.run_id = start.run_id and c.thread_id = start.thread_id and c.command ->> 'kind' = 'cancel')`.as(
        'is_stopping',
      ),
    )
    .select(
      sql<boolean>`exists (select 1 from product.execution_events e where e.run_id = start.run_id and e.thread_id = start.thread_id and e.payload ->> 'kind' = 'run-started')`.as(
        'is_running',
      ),
    )
    .where('start.thread_id', '=', threadID)
    .where(sql<string>`start.command ->> 'kind'`, '=', 'start')
    .where(
      sql<boolean>`not exists (select 1 from product.execution_events e where e.run_id = start.run_id and e.thread_id = start.thread_id and e.payload ->> 'kind' in ('run-completed','run-cancelled','run-failed'))`,
    )
    .orderBy('start.created_at')
    .execute()
  return runs.map((run) => {
    if (!run.message_id)
      throw new Error('Accepted start lacks message identity')
    return {
      runID: run.run_id,
      messageID: run.message_id,
      status: run.is_stopping
        ? 'stopping'
        : run.is_running
          ? 'running'
          : 'accepted',
    }
  })
}
