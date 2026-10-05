import { expect, test } from 'bun:test'
import {
  authorizeThread,
  decideThreadAccess,
  authorizeCancellation,
  decideMessageReplay,
  normalizeMessageIntent,
} from './submission'

const intent = {
  ownerID: 'Owner-ABC',
  threadID: 'ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF',
  messageID: 'BCDEFABC-DEFA-4BCD-8EFA-BCDEFABCDEFA',
  commandID: 'CDEFABCD-EFAB-4CDE-8FAB-CDEFABCDEFAB',
  runID: 'DEFABCDE-FABC-4DEF-8ABC-DEFABCDEFABC',
  text: ' \tHello\nworld ',
}

test.each(['', ' ', '\t\n'])(
  'blank text %j cannot form a submission',
  (text) => {
    expect(normalizeMessageIntent({ ...intent, text })).toBeNull()
  },
)

test('normalization preserves opaque ownership and canonicalizes all execution identities', () => {
  expect(normalizeMessageIntent(intent)).toEqual({
    ownerID: 'Owner-ABC',
    threadID: 'abcdefab-cdef-4abc-8def-abcdefabcdef',
    messageID: 'bcdefabc-defa-4bcd-8efa-bcdefabcdefa',
    commandID: 'cdefabcd-efab-4cde-8fab-cdefabcdefab',
    runID: 'defabcde-fabc-4def-8abc-defabcdefabc',
    text: 'Hello\nworld',
  })
})

test('authorization treats missing and foreign threads equally without case-folding owners', () => {
  expect(authorizeThread('Owner-ABC', 'Owner-ABC')).toBe('authorized')
  expect(authorizeThread('Owner-ABC', 'owner-abc')).toBe('unavailable')
  expect(authorizeThread('Owner-ABC', null)).toBe('unavailable')
  expect(authorizeCancellation(false)).toBe('unavailable')
  expect(authorizeCancellation(true)).toBe('authorized')
})

const saved = {
  threadID: intent.threadID,
  role: 'user',
  text: intent.text,
  commandID: 'persisted-command',
  runID: 'persisted-run',
}

test('exact replay uses durable execution identities, not retry candidates', () => {
  expect(decideMessageReplay(intent, saved)).toEqual({
    kind: 'accepted',
    messageID: intent.messageID,
    commandID: 'persisted-command',
    runID: 'persisted-run',
  })
  expect(decideMessageReplay(intent, null)).toBeNull()
})

test.each([
  { threadID: 'another-thread' },
  { role: 'assistant' },
  { text: 'Different' },
  { commandID: null },
  { runID: null },
])(
  'conflicting or incomplete replay cannot borrow execution IDs: %j',
  (changed) => {
    expect(decideMessageReplay(intent, { ...saved, ...changed })).toEqual({
      kind: 'conflict',
    })
  },
)

test('archived owned history and explicit stopping remain readable, but new writes and retries do not', () => {
  const archived = { ownerID: 'Owner-ABC', archived: true }
  expect(decideThreadAccess('Owner-ABC', archived, 'read')).toBe('authorized')
  expect(decideThreadAccess('Owner-ABC', archived, 'cancel')).toBe('authorized')
  expect(decideThreadAccess('Owner-ABC', archived, 'write')).toBe('conflict')
  expect(decideThreadAccess('other', archived, 'write')).toBe('unavailable')
  expect(decideThreadAccess('Owner-ABC', null, 'write')).toBe('unavailable')
})
