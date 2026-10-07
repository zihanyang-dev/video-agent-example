import { afterAll, expect, test } from 'bun:test'
import { sql } from 'kysely'
import { startCommandSchema } from '@vid/contract/execution'
import { acceptMessageIntent } from '../../apps/server/src/db/submissions'
import { publishCommand } from '../../apps/server/src/db/command-publication'
import type { SubmitMessageInput } from '../../apps/server/src/conversation/submission'

async function submitMessage(
  db: Parameters<typeof acceptMessageIntent>[0],
  input: SubmitMessageInput,
) {
  return await acceptMessageIntent(db, {
    ...input,
    commandID: crypto.randomUUID(),
    runID: crypto.randomUUID(),
  })
}
import { seedTestUser, openTestDatabase } from './database-fixture'

const { db, close } = openTestDatabase()

const threadIDs: string[] = []
afterAll(async () => {
  try {
    if (threadIDs.length === 0) return
    await db.deleteFrom('product.command_outbox').where('thread_id', 'in', threadIDs).execute()
    await db.deleteFrom('product.message_assets').where('thread_id', 'in', threadIDs).execute()
    await db.deleteFrom('product.assets').where('thread_id', 'in', threadIDs).execute()
    await db.deleteFrom('product.messages').where('thread_id', 'in', threadIDs).execute()
    await db.deleteFrom('product.threads').where('thread_id', 'in', threadIDs).execute()
  } finally {
    await close()
  }
})

async function inputForThread() {
  const threadID = crypto.randomUUID()
  const ownerID = 'submission-test-owner'
  await seedTestUser(db, ownerID)
  await db
    .insertInto('product.threads')
    .values({ thread_id: threadID, owner_id: ownerID })
    .execute()
  threadIDs.push(threadID)
  return { ownerID, threadID, messageID: crypto.randomUUID(), text: 'Hello' }
}

async function savedAcceptance(threadID: string) {
  return {
    messages: await db
      .selectFrom('product.messages')
      .selectAll()
      .where('thread_id', '=', threadID)
      .execute(),
    commands: await db
      .selectFrom('product.command_outbox')
      .selectAll()
      .where('thread_id', '=', threadID)
      .execute(),
  }
}

test('acceptance commits a normalized user message and a matching pending execution command', async () => {
  const input = await inputForThread()
  const accepted = await submitMessage(db, { ...input, text: '  Hello  ' })
  expect(accepted.kind).toBe('accepted')
  if (accepted.kind !== 'accepted') throw new Error('Message was not accepted')

  const saved = await savedAcceptance(input.threadID)
  expect(saved.messages).toHaveLength(1)
  expect(saved.messages[0]).toMatchObject({
    message_id: input.messageID,
    text: 'Hello',
    role: 'user',
  })
  expect(saved.commands).toHaveLength(1)
  expect(saved.commands[0]).toMatchObject({
    command_id: accepted.commandID,
    run_id: accepted.runID,
    published_at: null,
  })
  expect(startCommandSchema.parse(saved.commands[0]?.command)).toEqual({
    version: 1,
    kind: 'start',
    commandID: accepted.commandID,
    runID: accepted.runID,
    threadID: input.threadID,
    input: { messageID: input.messageID, text: 'Hello' },
  })
})

test('foreign and missing threads are unavailable without storing an input or command', async () => {
  const input = await inputForThread()
  expect(await submitMessage(db, { ...input, ownerID: 'other-owner' })).toEqual({
    kind: 'unavailable',
  })
  expect(await submitMessage(db, { ...input, threadID: crypto.randomUUID() })).toEqual({
    kind: 'unavailable',
  })
  expect(await savedAcceptance(input.threadID)).toEqual({
    messages: [],
    commands: [],
  })
})

test('identical retries preserve execution IDs before and after publication', async () => {
  const input = await inputForThread()
  const first = await submitMessage(db, input)
  expect(first.kind).toBe('accepted')
  expect(await submitMessage(db, input)).toEqual(first)
  if (first.kind !== 'accepted') throw new Error('Message was not accepted')
  expect(
    await publishCommand(db, {
      commandID: first.commandID,
      publish: async () => {},
    }),
  ).toBe('published')
  expect(await submitMessage(db, input)).toEqual(first)
  const saved = await savedAcceptance(input.threadID)
  expect(saved.messages).toHaveLength(1)
  expect(saved.commands).toHaveLength(1)
})

test('concurrent identical inputs commit exactly one message and pending command', async () => {
  const input = await inputForThread()
  const accepted = await Promise.all(Array.from({ length: 8 }, () => submitMessage(db, input)))
  const first = accepted[0]
  if (first === undefined) throw new Error('No submission outcome')
  expect(first.kind).toBe('accepted')
  for (const outcome of accepted) expect(outcome).toEqual(first)
  const saved = await savedAcceptance(input.threadID)
  expect(saved.messages).toHaveLength(1)
  expect(saved.commands).toHaveLength(1)
})

test('conflicting retries do not replace the accepted message or create another command', async () => {
  const input = await inputForThread()
  expect((await submitMessage(db, input)).kind).toBe('accepted')
  expect(await submitMessage(db, { ...input, text: 'Different' })).toEqual({
    kind: 'conflict',
  })
  const saved = await savedAcceptance(input.threadID)
  expect(saved.messages).toHaveLength(1)
  expect(saved.messages[0]?.text).toBe('Hello')
  expect(saved.commands).toHaveLength(1)
})

test('reusing a message ID for a different owned thread cannot borrow its execution', async () => {
  const first = await inputForThread()
  const second = await inputForThread()
  expect((await submitMessage(db, first)).kind).toBe('accepted')
  expect(await submitMessage(db, { ...second, messageID: first.messageID })).toEqual({
    kind: 'conflict',
  })
  expect(await savedAcceptance(second.threadID)).toEqual({
    messages: [],
    commands: [],
  })
})

test('a command ID collision rolls back the newly inserted message', async () => {
  const input = await inputForThread()
  const first = await submitMessage(db, input)
  if (first.kind !== 'accepted') throw new Error('Message was not accepted')
  const messageID = crypto.randomUUID()
  expect(
    await acceptMessageIntent(db, {
      ...input,
      messageID,
      commandID: first.commandID,
      runID: crypto.randomUUID(),
    }),
  ).toEqual({ kind: 'conflict' })
  const saved = await savedAcceptance(input.threadID)
  expect(saved.messages).toHaveLength(1)
  expect(saved.messages[0]?.message_id).toBe(input.messageID)
  expect(saved.commands).toHaveLength(1)
})

test('mixed-case submission preserves canonical IDs and opaque owners on replay', async () => {
  const input = {
    ownerID: 'Owner-ABC',
    threadID: 'abcdefab-cdef-4abc-8def-abcdefabcdef',
    messageID: 'bcdefabc-defa-4bcd-8efa-bcdefabcdefa',
    text: 'Hello',
  }
  await seedTestUser(db, input.ownerID)
  await db
    .insertInto('product.threads')
    .values({ thread_id: input.threadID, owner_id: input.ownerID })
    .execute()
  threadIDs.push(input.threadID)
  expect(await submitMessage(db, { ...input, ownerID: 'owner-abc' })).toEqual({
    kind: 'unavailable',
  })
  const upper = {
    ...input,
    threadID: input.threadID.toUpperCase(),
    messageID: input.messageID.toUpperCase(),
  }
  const accepted = await submitMessage(db, upper)
  expect(accepted).toMatchObject({
    kind: 'accepted',
    messageID: input.messageID,
  })
  expect(await submitMessage(db, upper)).toEqual(accepted)
  expect(await submitMessage(db, input)).toEqual(accepted)
  if (accepted.kind !== 'accepted') {
    throw new Error('Expected accepted message')
  }
  const saved = await savedAcceptance(input.threadID)
  expect(saved.commands[0]?.command).toEqual({
    version: 1,
    kind: 'start',
    commandID: accepted.commandID,
    runID: accepted.runID,
    threadID: input.threadID,
    input: { messageID: input.messageID, text: 'Hello' },
  })
})

test('direct uppercase intents return and retain canonical replay identities', async () => {
  const input = await inputForThread()
  const intent = {
    ...input,
    threadID: input.threadID.toUpperCase(),
    messageID: 'CDEFABCD-EFAB-4CDE-8FAB-CDEFABCDEFAB',
    commandID: 'DEFABCDE-FABC-4DEF-8ABC-DEFABCDEFABC',
    runID: 'EFABCDEF-ABCD-4EFA-8BCD-EFABCDEFABCD',
  }
  const direct = await acceptMessageIntent(db, intent)
  expect(direct).toEqual({
    kind: 'accepted',
    messageID: 'cdefabcd-efab-4cde-8fab-cdefabcdefab',
    commandID: 'defabcde-fabc-4def-8abc-defabcdefabc',
    runID: 'efabcdef-abcd-4efa-8bcd-efabcdefabcd',
  })
  expect(await acceptMessageIntent(db, intent)).toEqual(direct)
  expect(
    await acceptMessageIntent(db, {
      ...intent,
      threadID: input.threadID,
      messageID: intent.messageID.toLowerCase(),
      commandID: intent.commandID.toLowerCase(),
      runID: intent.runID.toLowerCase(),
    }),
  ).toEqual(direct)
})

test('a foreign message identity returns unavailable rather than revealing a conflicting stored message', async () => {
  const first = await inputForThread()
  await submitMessage(db, first)
  const second = await inputForThread()
  await seedTestUser(db, 'another-authenticated-user')
  await db
    .updateTable('product.threads')
    .set({ owner_id: 'another-authenticated-user' })
    .where('thread_id', '=', second.threadID)
    .execute()
  expect(
    await submitMessage(db, {
      ...second,
      ownerID: 'another-authenticated-user',
      messageID: first.messageID,
    }),
  ).toEqual({ kind: 'unavailable' })
  expect(await savedAcceptance(second.threadID)).toEqual({
    messages: [],
    commands: [],
  })
})

for (const [name, patch] of Object.entries({
  'string version': { version: '1' },
  kind: { kind: 'cancel' },
  'JSON command ID': { commandID: 'not-a-uuid' },
  'JSON run ID': { runID: crypto.randomUUID() },
  'JSON thread ID': { threadID: crypto.randomUUID() },
  'JSON input ID': { input: { messageID: crypto.randomUUID(), text: 'Hello' } },
  'wire text': { input: { text: 'different work' } },
})) {
  test(`exact replay rejects retained ${name} corruption without repairing history`, async () => {
    const input = await inputForThread()
    const accepted = await submitMessage(db, input)
    if (accepted.kind !== 'accepted') throw new Error('Expected acceptance')
    const saved = await savedAcceptance(input.threadID)
    const command = startCommandSchema.parse(saved.commands[0]?.command)
    const corrupt = {
      ...command,
      ...patch,
      input: { ...command.input, ...('input' in patch ? patch.input : {}) },
    }
    await db
      .updateTable('product.command_outbox')
      .set({ command: sql`${JSON.stringify(corrupt)}::jsonb` })
      .where('command_id', '=', accepted.commandID)
      .execute()
    const before = await savedAcceptance(input.threadID)
    expect(await submitMessage(db, input)).toEqual({ kind: 'conflict' })
    expect(await savedAcceptance(input.threadID)).toEqual(before)
  })
}

for (const header of ['command_id', 'run_id', 'thread_id', 'message_id'] as const) {
  test(`exact replay rejects inconsistent indexed ${header}`, async () => {
    const input = await inputForThread()
    const accepted = await submitMessage(db, input)
    if (accepted.kind !== 'accepted') throw new Error('Expected acceptance')
    const other = await inputForThread()
    await submitMessage(db, other)
    let value: string
    switch (header) {
      case 'thread_id':
        value = other.threadID
        break
      case 'message_id':
        value = other.messageID
        break
      case 'command_id':
      case 'run_id':
        value = crypto.randomUUID()
        break
    }
    // message_id is globally unique; remove the other command first.
    if (header === 'message_id')
      await db
        .deleteFrom('product.command_outbox')
        .where('message_id', '=', other.messageID)
        .execute()
    const mutation = db
      .updateTable('product.command_outbox')
      .set({ [header]: value })
      .where('command_id', '=', accepted.commandID)
    if (header === 'thread_id' || header === 'message_id') {
      const before = await savedAcceptance(input.threadID)
      const rejected = await mutation.execute().catch((cause: unknown) => cause)
      expect(rejected).toMatchObject({
        code: '23503',
        constraint: 'command_outbox_message_identity',
      })
      expect(await savedAcceptance(input.threadID)).toEqual(before)
      expect(await submitMessage(db, input)).toEqual(accepted)
      return
    }
    await mutation.execute()
    const before = await savedAcceptance(input.threadID)
    const otherBefore = await savedAcceptance(other.threadID)
    expect(await submitMessage(db, input)).toEqual({ kind: 'conflict' })
    expect(await savedAcceptance(input.threadID)).toEqual(before)
    expect(await savedAcceptance(other.threadID)).toEqual(otherBefore)
  })
}

test('uppercase historical wire identities replay original IDs without rewriting JSON', async () => {
  const input = await inputForThread()
  const first = await submitMessage(db, input)
  if (first.kind !== 'accepted') throw new Error('Expected acceptance')
  const saved = await savedAcceptance(input.threadID)
  const command = startCommandSchema.parse(saved.commands[0]?.command)
  const historical = {
    ...command,
    commandID: command.commandID.toUpperCase(),
    runID: command.runID.toUpperCase(),
    threadID: command.threadID.toUpperCase(),
    input: {
      ...command.input,
      messageID: command.input.messageID.toUpperCase(),
    },
  }
  await db
    .updateTable('product.command_outbox')
    .set({ command: sql`${JSON.stringify(historical)}::jsonb` })
    .where('command_id', '=', first.commandID)
    .execute()
  expect(await submitMessage(db, input)).toEqual(first)
  expect((await savedAcceptance(input.threadID)).commands[0]?.command).toEqual(
    JSON.parse(JSON.stringify(historical)),
  )
})

async function inputWithAssets() {
  const input = await inputForThread()
  const assets = Array.from({ length: 2 }, (_, index) => {
    const assetID = crypto.randomUUID()
    return {
      assetID,
      name: `input-${index}.txt`,
      mimeType: 'text/plain',
      byteLength: 2,
      sha256: 'a'.repeat(64),
      objectKey: `materials/${input.threadID}/${assetID}`,
    }
  })
  for (const asset of assets)
    await db
      .insertInto('product.assets')
      .values({
        asset_id: asset.assetID,
        thread_id: input.threadID,
        source: 'upload',
        name: asset.name,
        mime_type: asset.mimeType,
        byte_length: asset.byteLength,
        sha256: asset.sha256,
        object_key: asset.objectKey,
        ready_at: new Date(),
      })
      .execute()
  return {
    input: { ...input, assetIDs: assets.map((asset) => asset.assetID) },
    assets,
  }
}

const assetMutations = {
  order: (assets: Awaited<ReturnType<typeof inputWithAssets>>['assets']) => assets.reverse(),
  missing: (assets: Awaited<ReturnType<typeof inputWithAssets>>['assets']) => assets.pop(),
  extra: (assets: Awaited<ReturnType<typeof inputWithAssets>>['assets']) =>
    assets.push({ ...assets[0]!, assetID: crypto.randomUUID() }),
  ID: (assets: Awaited<ReturnType<typeof inputWithAssets>>['assets']) => {
    assets[0]!.assetID = crypto.randomUUID()
  },
  name: (assets: Awaited<ReturnType<typeof inputWithAssets>>['assets']) => {
    assets[0]!.name = 'different.txt'
  },
  hash: (assets: Awaited<ReturnType<typeof inputWithAssets>>['assets']) => {
    assets[0]!.sha256 = 'b'.repeat(64)
  },
  bytes: (assets: Awaited<ReturnType<typeof inputWithAssets>>['assets']) => {
    assets[0]!.byteLength = 3
  },
  key: (assets: Awaited<ReturnType<typeof inputWithAssets>>['assets']) => {
    assets[0]!.objectKey = `materials/${crypto.randomUUID()}/${assets[0]!.assetID}`
  },
}
for (const [mutation, mutate] of Object.entries(assetMutations)) {
  test(`exact replay rejects retained asset ${mutation} corruption`, async () => {
    const { input, assets } = await inputWithAssets()
    const first = await submitMessage(db, input)
    if (first.kind !== 'accepted') throw new Error('Expected acceptance')
    const command = startCommandSchema.parse(
      (await savedAcceptance(input.threadID)).commands[0]?.command,
    )
    const changed = assets.map((asset) => ({ ...asset }))
    mutate(changed)
    await db
      .updateTable('product.command_outbox')
      .set({
        command: { ...command, input: { ...command.input, assets: changed } },
      })
      .where('command_id', '=', first.commandID)
      .execute()
    const before = await savedAcceptance(input.threadID)
    expect(await submitMessage(db, input)).toEqual({ kind: 'conflict' })
    expect(await savedAcceptance(input.threadID)).toEqual(before)
  })
}

test('historical asset command keys remain replayable after current asset rehome', async () => {
  const { input, assets } = await inputWithAssets()
  const first = await submitMessage(db, input)
  const before = await savedAcceptance(input.threadID)
  for (const asset of assets)
    await db
      .updateTable('product.assets')
      .set({ object_key: `assets/uploads/${input.threadID}/${asset.assetID}` })
      .where('asset_id', '=', asset.assetID)
      .execute()
  expect(await submitMessage(db, input)).toEqual(first)
  expect(await savedAcceptance(input.threadID)).toEqual(before)
})

for (const foreignScope of [false, true]) {
  test(`cross-thread ${foreignScope ? 'foreign' : 'other owned'} indexed transfer is refused; wire-only corruption still conflicts`, async () => {
    const input = await inputForThread()
    const first = await submitMessage(db, input)
    if (first.kind !== 'accepted') throw new Error('Expected acceptance')
    const other = await inputForThread()
    if (foreignScope) {
      await seedTestUser(db, 'foreign-ledger-owner')
      await db
        .updateTable('product.threads')
        .set({ owner_id: 'foreign-ledger-owner' })
        .where('thread_id', '=', other.threadID)
        .execute()
    }
    const command = startCommandSchema.parse(
      (await savedAcceptance(input.threadID)).commands[0]?.command,
    )
    const original = await savedAcceptance(input.threadID)
    const rejected = await db
      .updateTable('product.command_outbox')
      .set({ thread_id: other.threadID })
      .where('command_id', '=', first.commandID)
      .execute()
      .catch((cause: unknown) => cause)
    expect(rejected).toMatchObject({
      code: '23503',
      constraint: 'command_outbox_message_identity',
    })
    expect(await savedAcceptance(input.threadID)).toEqual(original)
    await db
      .updateTable('product.command_outbox')
      .set({
        command: sql`${JSON.stringify({ ...command, threadID: other.threadID })}::jsonb`,
      })
      .where('command_id', '=', first.commandID)
      .execute()
    const before = await savedAcceptance(input.threadID)
    const otherBefore = await savedAcceptance(other.threadID)
    expect(await submitMessage(db, input)).toEqual({ kind: 'conflict' })
    expect(await savedAcceptance(input.threadID)).toEqual(before)
    expect(await savedAcceptance(other.threadID)).toEqual(otherBefore)
    // Authorization of the original product message precedes parsing bad ledger data.
    if (foreignScope)
      expect(
        await submitMessage(db, {
          ...other,
          ownerID: 'foreign-ledger-owner',
          messageID: input.messageID,
        }),
      ).toEqual({ kind: 'unavailable' })
  })
}
