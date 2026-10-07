import { expect, test } from 'bun:test'
import { executionEventSchema } from './execution'
import { publicMessageSchema } from './http'

const id = '00000000-0000-4000-8000-000000000001'
const sources = [{ title: 'Found', url: 'https://example.org/source' }]
const completed = {
  version: 1,
  eventID: id,
  threadID: id,
  runID: id,
  messageID: id,
  kind: 'run-completed',
  text: 'Final',
  sources,
}

test('sources are strict optional canonical completion facts, never cancellation or failure facts', () => {
  expect(executionEventSchema.safeParse(completed).success).toBe(true)
  expect(
    publicMessageSchema.safeParse({
      messageID: id,
      role: 'assistant',
      text: 'Final',
      createdAt: '2026-10-05T00:00:00Z',
      sources,
    }).success,
  ).toBe(true)
  for (const invalid of [
    Array(16).fill(sources[0]),
    [{ ...sources[0], snippet: 'PRIVATE CANARY' }],
    [{ ...sources[0], url: 'https://127.0.0.1/' }],
  ]) {
    expect(executionEventSchema.safeParse({ ...completed, sources: invalid }).success).toBe(false)
    expect(
      publicMessageSchema.safeParse({
        messageID: id,
        role: 'assistant',
        text: 'Final',
        createdAt: '2026-10-05T00:00:00Z',
        sources: invalid,
      }).success,
    ).toBe(false)
  }
  const { messageID: _messageID, text: _text, ...terminal } = completed
  expect(executionEventSchema.safeParse({ ...terminal, kind: 'run-cancelled' }).success).toBe(false)
  expect(
    executionEventSchema.safeParse({
      ...terminal,
      kind: 'run-failed',
      reason: 'execution-error',
    }).success,
  ).toBe(false)
})
