import { expect, test } from 'bun:test'
import type { ExecutionEvent } from '@vid/contract/execution'
import { planPublicReceipts } from './execution-receipts'

const start: ExecutionEvent = {
  version: 1,
  kind: 'run-started',
  eventID: 'start',
  threadID: 'thread',
  runID: 'run',
}
const text: ExecutionEvent = {
  ...start,
  kind: 'assistant-text',
  eventID: 'text',
  messageID: 'message',
  delta: 'Draft',
}
const completed: ExecutionEvent = {
  ...start,
  kind: 'run-completed',
  eventID: 'completed',
  messageID: 'message',
  text: 'Final',
}

test('a terminal behind a missing receipt cannot advance replay', () => {
  expect(
    planPublicReceipts([{ event: completed, ordinal: 3n, processed: false }]),
  ).toEqual({ kind: 'ready', publications: [] })
})

test('contiguous receipts suppress drafts and facts after a known terminal', () => {
  expect(
    planPublicReceipts([
      { event: start, ordinal: 1n, processed: true },
      { event: text, ordinal: 2n, processed: false },
      { event: completed, ordinal: 3n, processed: false },
      { event: { ...start, eventID: 'late' }, ordinal: 4n, processed: false },
    ]),
  ).toEqual({
    kind: 'ready',
    publications: [
      { eventID: 'text', suppressed: true },
      { eventID: 'completed', suppressed: false },
      { eventID: 'late', suppressed: true },
    ],
  })
})

test('a second terminal conflicts rather than replacing canonical completion', () => {
  expect(
    planPublicReceipts([
      { event: completed, ordinal: 1n, processed: true },
      {
        event: { ...start, kind: 'run-cancelled' },
        ordinal: 2n,
        processed: false,
      },
    ]),
  ).toEqual({ kind: 'conflict' })
})

test('one run cannot publish assistant text under two message identities', () => {
  expect(
    planPublicReceipts([
      { event: text, ordinal: 1n, processed: false },
      {
        event: { ...completed, messageID: 'other-message' },
        ordinal: 2n,
        processed: false,
      },
    ]),
  ).toEqual({ kind: 'conflict' })
})
