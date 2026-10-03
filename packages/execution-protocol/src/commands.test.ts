import { describe, expect, test } from 'bun:test'
import {
  cancelCommandSchema,
  executionCommandSchema,
  startCommandSchema,
} from './index'

const start = {
  version: 1,
  kind: 'start',
  commandID: '11111111-1111-4111-8111-111111111111',
  threadID: '22222222-2222-4222-8222-222222222222',
  runID: '33333333-3333-4333-8333-333333333333',
  input: {
    messageID: '44444444-4444-4444-8444-444444444444',
    text: '  Hello\nworld  ',
  },
} as const
const cancel = {
  version: 1,
  kind: 'cancel',
  commandID: start.commandID,
  threadID: start.threadID,
  runID: start.runID,
} as const

describe('execution commands v1', () => {
  test('accepts start without changing message text', () => {
    expect(startCommandSchema.parse(start)).toEqual(start)
    expect(executionCommandSchema.parse(start)).toEqual(start)
  })

  test('accepts cancel without an input', () => {
    expect(cancelCommandSchema.parse(cancel)).toEqual(cancel)
    expect(executionCommandSchema.parse(cancel)).toEqual(cancel)
  })

  const malformed: readonly unknown[] = [
    null,
    [],
    {},
    { ...start, version: 2 },
    { ...cancel, version: '1' },
    { ...start, kind: 'resume' },
    { ...start, extra: true },
    { ...cancel, input: start.input },
    { ...start, input: { ...start.input, extra: true } },
    { ...start, commandID: 'not-a-uuid' },
    { ...start, threadID: 'not-a-uuid' },
    { ...start, runID: 'not-a-uuid' },
    { ...start, input: { ...start.input, messageID: 'not-a-uuid' } },
    { ...start, input: { ...start.input, text: '' } },
    { ...start, input: { ...start.input, text: ' \t\n ' } },
    { ...start, input: { ...start.input, text: 123 } },
    { ...cancel, commandID: null },
    { ...cancel, threadID: 123 },
    { ...cancel, runID: '' },
    { ...cancel, extra: true },
    { ...cancel, version: 0 },
    { ...start, input: { text: 'hello' } },
  ]

  test.each(malformed.map((command, index) => [index, command] as const))(
    'rejects malformed wire command %i',
    (_index, command) => {
      expect(executionCommandSchema.safeParse(command).success).toBe(false)
    },
  )

  test('parsed identities and accepted input resist mutation', () => {
    const parsed = startCommandSchema.parse(start)
    expect(Reflect.set(parsed, 'runID', 'another-run')).toBe(false)
    expect(Reflect.set(parsed.input, 'text', 'replacement')).toBe(false)
    expect(parsed.runID).toBe(start.runID)
    expect(parsed.input.text).toBe('  Hello\nworld  ')
  })
})
