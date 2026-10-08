import { expect, test } from 'bun:test'
import { CONVERSATION_CONTEXT_MAX_BYTES, conversationContextSchema } from './conversation-context'

const runID = '11111111-1111-4111-8111-111111111111'
const turn = {
  runID,
  input: { messageID: '22222222-2222-4222-8222-222222222222', text: 'Question' },
  output: {
    messageID: '33333333-3333-4333-8333-333333333333',
    text: 'Answer',
    sources: [{ title: 'Evidence', url: 'https://example.com/fact' }],
  },
}
const context = { version: 1 as const, throughRunID: runID, turns: [turn] }

test('accepts completed history and an empty initial context', () => {
  expect(conversationContextSchema.parse(context)).toEqual(context)
  expect(conversationContextSchema.parse({ version: 1, throughRunID: null, turns: [] })).toEqual({
    version: 1,
    throughRunID: null,
    turns: [],
  })
})

test.each([
  { name: 'cutoff', value: { ...context, throughRunID: null } },
  { name: 'duplicate run', value: { ...context, turns: [turn, turn] } },
  {
    name: 'duplicate message',
    value: {
      ...context,
      turns: [{ ...turn, output: { ...turn.output, messageID: turn.input.messageID } }],
    },
  },
  { name: 'unknown context field', value: { ...context, provider: 'opaque' } },
  { name: 'unknown turn field', value: { ...context, turns: [{ ...turn, runState: 'opaque' }] } },
  {
    name: 'unknown input field',
    value: { ...context, turns: [{ ...turn, input: { ...turn.input, toolCalls: [] } }] },
  },
])('rejects invalid business context: $name', ({ value }) => {
  expect(conversationContextSchema.safeParse(value).success).toBe(false)
})

test('bounds serialized UTF8 business material without relying on a harness renderer', () => {
  const value = { ...context, turns: [{ ...turn, input: { ...turn.input, text: '' } }] }
  const overhead = new TextEncoder().encode(JSON.stringify(value)).byteLength
  value.turns[0]!.input.text = 'a'.repeat(CONVERSATION_CONTEXT_MAX_BYTES - overhead)
  expect(conversationContextSchema.safeParse(value).success).toBe(true)
  value.turns[0]!.input.text += '界'
  expect(conversationContextSchema.safeParse(value).success).toBe(false)
})

test('preserves private asset facts in the business contract, not as model input', () => {
  const asset = {
    assetID: '44444444-4444-4444-8444-444444444444',
    objectKey: 'private-key',
    name: 'fact.txt',
    mimeType: 'text/plain',
    byteLength: 10,
    sha256: 'a'.repeat(64),
  }
  const value = { ...context, turns: [{ ...turn, input: { ...turn.input, assets: [asset] } }] }
  expect(conversationContextSchema.parse(value).turns[0]!.input.assets).toEqual([asset])
  const withOutputAsset = {
    ...context,
    turns: [{ ...turn, output: { ...turn.output, assets: [asset] } }],
  }
  // Stored bootstrap digests include canonical v1 property order.
  expect(JSON.stringify(conversationContextSchema.parse(withOutputAsset))).toBe(
    JSON.stringify(withOutputAsset),
  )
})
