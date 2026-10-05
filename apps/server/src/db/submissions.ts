import { assetBudgetDefaults } from '@vid/config'
import { allocatedAssets, messageAssets } from './assets'
import { lockThread } from './thread-access'
import { threadUnavailable, threadConflict } from './thread-access'
import {
  normalizeMessageIntent,
  decideMessageReplay,
} from '../conversation/submission'
import type { DB } from '@vid/database/types'
import { startCommandSchema, type StartCommand } from '@vid/contract/execution'
import { sameFile } from '../assets/files'
import type { Kysely, Transaction } from 'kysely'
import type {
  SubmitMessageOutcome,
  MessageIntent,
  SubmitIntentOutcome,
} from '../conversation/submission'

// Throwing inside Kysely's callback rolls back the message when its command cannot be committed.
const commandCollision = new Error('Pending command identity collision')

// The thread lock is the authority for ownership and serializes acceptance with
// archive state changes. Message/outbox writes commit together; an ID collision must
// roll back the message rather than leave an input that can never execute.
export async function acceptMessageIntent(
  db: Kysely<DB>,
  input: MessageIntent,
  maxAssetBytes: number = assetBudgetDefaults.ASSET_MAX_BYTES,
): Promise<SubmitMessageOutcome> {
  const intent = normalizeMessageIntent(input)
  if (intent === null) return { kind: 'invalid-input' }
  try {
    return await db
      .transaction()
      .execute((tx) => acceptMessage(tx, intent, maxAssetBytes))
  } catch (error) {
    if (error === threadConflict) return { kind: 'conflict' }
    if (error === commandCollision) return { kind: 'conflict' }
    if (error === threadUnavailable) return { kind: 'unavailable' }
    throw error
  }
}

async function acceptMessage(
  tx: Transaction<DB>,
  intent: MessageIntent,
  maxAssetBytes: number,
): Promise<SubmitIntentOutcome> {
  await lockThread(tx, intent, 'write')

  const replay = await acceptedMessage(tx, intent)
  if (replay !== null) return replay

  const message = await tx
    .insertInto('product.messages')
    .values({
      message_id: intent.messageID,
      thread_id: intent.threadID,
      role: 'user',
      text: intent.text,
    })
    .onConflict((conflict) => conflict.column('message_id').doNothing())
    .returning('message_id')
    .executeTakeFirst()
  if (message === undefined) {
    // Message IDs are global, so another thread can win after the first replay query.
    // Read Committed gives this query a fresh snapshot after the conflicting insert waits.
    const concurrentReplay = await acceptedMessage(tx, intent)
    if (concurrentReplay !== null) return concurrentReplay
    return { kind: 'conflict' }
  }

  const assets = await allocatedAssets(
    tx,
    intent.threadID,
    intent.assetIDs ?? [],
  )
  if (
    assets.reduce((total, asset) => total + asset.byteLength, 0) > maxAssetBytes
  )
    throw threadConflict
  for (const [position, asset] of assets.entries())
    await tx
      .insertInto('product.message_assets')
      .values({
        thread_id: intent.threadID,
        message_id: intent.messageID,
        asset_id: asset.assetID,
        position,
      })
      .execute()
  await enqueueMessage(tx, intent, assets)
  return {
    kind: 'accepted',
    messageID: intent.messageID,
    commandID: intent.commandID,
    runID: intent.runID,
  }
}

async function acceptedMessage(
  tx: Transaction<DB>,
  intent: MessageIntent,
): Promise<SubmitIntentOutcome | null> {
  // Published outbox rows still supply replay IDs; purging them would break identical retries.
  const message = await tx
    .selectFrom('product.messages as message')
    .innerJoin(
      'product.threads as scope',
      'scope.thread_id',
      'message.thread_id',
    )
    .leftJoin(
      'product.command_outbox as command',
      'command.message_id',
      'message.message_id',
    )
    .select([
      'scope.owner_id',
      'message.thread_id',
      'message.role',
      'message.text',
      'command.command_id',
      'command.run_id',
      'command.thread_id as command_thread_id',
      'command.message_id as command_message_id',
      'command.command',
    ])
    .where('message.message_id', '=', intent.messageID)
    .executeTakeFirst()
  // A foreign global message ID must not disclose a stored message conflict.
  // Ownership is immutable; current-thread acceptance remains under its lock.
  if (message !== undefined && message.owner_id !== intent.ownerID)
    return { kind: 'unavailable' }
  if (message === undefined) return null
  const assets = await messageAssets(tx, intent.messageID)
  // The retained wire command is a separate untyped boundary. Schema parsing
  // canonicalizes historical UUID case; indexed headers and product input still
  // have to name the same accepted work. Never repair or replace bad history.
  const retained = startCommandSchema.safeParse(message.command)
  if (!retained.success) return { kind: 'conflict' }
  const command = retained.data
  const matchingHeaders = [
    [command.commandID, message.command_id],
    [command.runID, message.run_id],
    [command.threadID, message.command_thread_id],
    [command.threadID, message.thread_id],
    [command.input.messageID, message.command_message_id],
  ].every(([wire, indexed]) => wire === indexed)
  if (!matchingHeaders || command.input.text !== message.text)
    return { kind: 'conflict' }
  const references = command.input.assets ?? []
  if (
    references.length !== assets.length ||
    !references.every((reference, position) => {
      const asset = assets[position]
      if (!asset || reference.assetID !== asset.asset_id) return false
      // File content metadata is immutable. Location is not: rehome may move
      // the current row while an accepted command retains its old physical key.
      const validLocation =
        asset.source === 'upload'
          ? reference.objectKey ===
              `materials/${asset.thread_id}/${asset.asset_id}` ||
            reference.objectKey ===
              `assets/uploads/${asset.thread_id}/${asset.asset_id}`
          : new RegExp(
              `^(artifacts|assets/generated)/${asset.thread_id}/${asset.run_id}/[1-9][0-9]*/${asset.asset_id}$`,
            ).test(reference.objectKey)
      return (
        validLocation &&
        sameFile(reference, {
          name: asset.name,
          mimeType: asset.mime_type,
          byteLength: asset.byte_length,
          sha256: asset.sha256,
        })
      )
    })
  )
    return { kind: 'conflict' }
  return decideMessageReplay(intent, {
    threadID: message.thread_id,
    role: message.role,
    text: message.text,
    assetIDs: assets.map((row) => row.asset_id),
    commandID: message.command_id,
    runID: message.run_id,
  })
}

async function enqueueMessage(
  tx: Transaction<DB>,
  intent: MessageIntent,
  assets: Awaited<ReturnType<typeof allocatedAssets>>,
): Promise<void> {
  // This typed construction needs no runtime parse; stored JSON is parsed when read.
  const command = {
    version: 1,
    kind: 'start',
    commandID: intent.commandID,
    threadID: intent.threadID,
    runID: intent.runID,
    input: {
      messageID: intent.messageID,
      text: intent.text,
      ...(assets.length === 0 ? {} : { assets }),
    },
  } satisfies StartCommand
  const pending = await tx
    .insertInto('product.command_outbox')
    .values({
      command_id: intent.commandID,
      thread_id: intent.threadID,
      run_id: intent.runID,
      message_id: intent.messageID,
      command,
    })
    .onConflict((conflict) => conflict.doNothing())
    .returning('command_id')
    .executeTakeFirst()
  if (pending === undefined) throw commandCollision
}
