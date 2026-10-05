import { RunAgentInputSchema } from '@ag-ui/core/schemas'
import {
  messageSubmissionSchema,
  runCancellationSchema,
  type MessageAccepted,
  type CancellationAccepted,
} from '@vid/contract/http'
import type { DB } from '@vid/database/types'
import type { Kysely } from 'kysely'
import { z } from 'zod'
import type { OwnedThread } from './submission'
import { hasPublicCursor } from '../db/execution-events'
import { cancelRun, hasAcceptedRun } from '../db/cancellations'
import { acceptMessageIntent } from '../db/submissions'
import { observeEvents, type RegisterSubscription } from './event-stream'
const cursorSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .pipe(z.string().refine((value) => BigInt(value) <= 9223372036854775807n))
const unavailable = () => Response.json({ error: 'Not found' }, { status: 404 })
const invalid = () => Response.json({ error: 'Invalid input' }, { status: 400 })
const conflict = () => Response.json({ error: 'Conflict' }, { status: 409 })
export type ConversationOptions = Readonly<{
  signal: AbortSignal
  pollIntervalMs: number
  registerSubscription?: RegisterSubscription
}>

export async function submitMessage(
  db: Kysely<DB>,
  query: OwnedThread,
  body: unknown,
  maxAssetBytes: number,
) {
  const input = messageSubmissionSchema.safeParse(body)
  if (!input.success) return invalid()
  const outcome = await acceptMessageIntent(
    db,
    {
      ...query,
      messageID: input.data.messageID,
      text: input.data.text,
      assetIDs: input.data.assetIDs,
      commandID: crypto.randomUUID(),
      runID: crypto.randomUUID(),
    },
    maxAssetBytes,
  )
  if (outcome.kind === 'unavailable') return unavailable()
  if (outcome.kind === 'invalid-input') return invalid()
  if (outcome.kind === 'conflict') return conflict()
  return Response.json(
    {
      messageID: outcome.messageID,
      commandID: outcome.commandID,
      runID: outcome.runID,
    } satisfies MessageAccepted,
    { status: 202 },
  )
}

export async function cancelObservation(
  db: Kysely<DB>,
  query: OwnedThread & { runID: string },
  body: unknown,
) {
  const input = runCancellationSchema.safeParse(body)
  if (!input.success) return invalid()
  const outcome = await cancelRun(db, { ...query, ...input.data })
  if (outcome === 'unavailable') return unavailable()
  if (outcome === 'conflict') return conflict()
  return Response.json(
    {
      commandID: input.data.commandID,
      runID: query.runID,
    } satisfies CancellationAccepted,
    { status: 202 },
  )
}

export async function openObservation(
  db: Kysely<DB>,
  query: OwnedThread & { runID: string },
  request: Readonly<{ body: unknown; headers: Headers; signal: AbortSignal }>,
  options: ConversationOptions & { authorize: () => Promise<boolean> },
) {
  const input = RunAgentInputSchema.safeParse(request.body)
  if (!input.success) return invalid()
  const runID = z.uuid().toLowerCase().safeParse(input.data.runId)
  const inputThread = z.uuid().toLowerCase().safeParse(input.data.threadId)
  if (
    !runID.success ||
    !inputThread.success ||
    inputThread.data !== query.threadID ||
    runID.data !== query.runID
  )
    return invalid()
  const after = observationCursor(
    input.data.forwardedProps,
    request.headers.get('last-event-id'),
  )
  if (after === null) return invalid()
  if (!(await hasAcceptedRun(db, query))) return unavailable()
  if (!(await hasPublicCursor(db, { threadID: query.threadID, after })))
    return invalid()
  return await observeEvents(db, {
    ...query,
    after,
    pollMs: options.pollIntervalMs,
    requestSignal: request.signal,
    processSignal: options.signal,
    authorize: options.authorize,
    ...(options.registerSubscription
      ? { registerSubscription: options.registerSubscription }
      : {}),
  })
}

function observationCursor(
  forwardedProps: unknown,
  header: string | null,
): string | null {
  if (header !== null) {
    const after = cursorSchema.safeParse(header)
    return after.success ? after.data : null
  }
  const props = z
    .object({ after: cursorSchema.optional() })
    .safeParse(forwardedProps ?? {})
  if (!props.success) return null
  const after = cursorSchema.safeParse(props.data.after ?? '0')
  return after.success ? after.data : null
}
