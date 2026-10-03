import { expect, test } from 'bun:test'
import {
  submitMessage,
  type ConversationWrites,
  type MessageIntent,
} from './submit-message'

const input = {
  ownerID: '11111111-1111-4111-8111-111111111111',
  threadID: '22222222-2222-4222-8222-222222222222',
  messageID: '33333333-3333-4333-8333-333333333333',
  text: 'Hello',
}

// Capture the normalized intent; persistence policy is covered by the real adapter.
function captureWrites() {
  const intents = new Map<string, MessageIntent>()
  const writes: ConversationWrites = {
    submit: async (intent) => {
      intents.set(intent.messageID, intent)
      return {
        kind: 'accepted',
        messageID: intent.messageID,
        commandID: intent.commandID,
        runID: intent.runID,
      }
    },
  }
  return { writes, intents }
}

test.each(['', ' ', '\t\n'])(
  'blank text %j does not submit an intent',
  async (text) => {
    const { writes, intents } = captureWrites()
    expect(await submitMessage(writes, { ...input, text })).toEqual({
      kind: 'invalid-input',
    })
    expect(intents.size).toBe(0)
  },
)

test('submission normalizes text and proposes fresh command and run UUIDs', async () => {
  const { writes, intents } = captureWrites()
  const outcome = await submitMessage(writes, {
    ...input,
    text: ' \tHello\nworld  ',
  })
  expect(outcome.kind).toBe('accepted')
  if (outcome.kind !== 'accepted') throw new Error('Expected acceptance')

  expect(outcome.messageID).toBe(input.messageID)
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  expect(outcome.commandID).toMatch(uuid)
  expect(outcome.runID).toMatch(uuid)
  expect(outcome.commandID).not.toBe(outcome.runID)
  expect(intents.get(input.messageID)).toEqual({
    ownerID: input.ownerID,
    threadID: input.threadID,
    messageID: input.messageID,
    text: 'Hello\nworld',
    commandID: outcome.commandID,
    runID: outcome.runID,
  })
})

test('returns the persisted IDs rather than the candidate IDs', async () => {
  const accepted = {
    kind: 'accepted',
    messageID: input.messageID,
    commandID: '44444444-4444-4444-8444-444444444444',
    runID: '55555555-5555-4555-8555-555555555555',
  } as const
  const writes: ConversationWrites = { submit: async () => accepted }
  expect(await submitMessage(writes, input)).toEqual(accepted)
})

test('distinct messages receive independent execution IDs', async () => {
  const { writes, intents } = captureWrites()
  const first = await submitMessage(writes, input)
  const second = await submitMessage(writes, {
    ...input,
    messageID: '44444444-4444-4444-8444-444444444444',
  })
  if (first.kind !== 'accepted' || second.kind !== 'accepted') {
    throw new Error('Expected acceptance')
  }
  expect(first.commandID).not.toBe(second.commandID)
  expect(first.runID).not.toBe(second.runID)
  expect(intents.size).toBe(2)
})
