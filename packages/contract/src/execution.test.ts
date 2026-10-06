import { failedRunSchema } from './http'
import { describe, expect, test } from 'bun:test'
import {
  cancelCommandSchema,
  executionCommandSchema,
  startCommandSchema,
  executionEventSchema,
  executionDeliverySchema,
} from './execution'

const commandStart = {
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
const commandCancel = {
  version: 1,
  kind: 'cancel',
  commandID: commandStart.commandID,
  threadID: commandStart.threadID,
  runID: commandStart.runID,
} as const

describe('execution commands v1', () => {
  test('accepts start without changing message text', () => {
    expect(startCommandSchema.parse(commandStart)).toEqual(commandStart)
    expect(executionCommandSchema.parse(commandStart)).toEqual(commandStart)
  })

  test('accepts cancel without an input', () => {
    expect(cancelCommandSchema.parse(commandCancel)).toEqual(commandCancel)
    expect(executionCommandSchema.parse(commandCancel)).toEqual(commandCancel)
  })

  const malformed: readonly unknown[] = [
    null,
    [],
    {},
    { ...commandStart, version: 2 },
    { ...commandCancel, version: '1' },
    { ...commandStart, kind: 'resume' },
    { ...commandStart, extra: true },
    { ...commandCancel, input: commandStart.input },
    { ...commandStart, input: { ...commandStart.input, extra: true } },
    { ...commandStart, commandID: 'not-a-uuid' },
    { ...commandStart, threadID: 'not-a-uuid' },
    { ...commandStart, runID: 'not-a-uuid' },
    {
      ...commandStart,
      input: { ...commandStart.input, messageID: 'not-a-uuid' },
    },
    { ...commandStart, input: { ...commandStart.input, text: '' } },
    { ...commandStart, input: { ...commandStart.input, text: ' \t\n ' } },
    { ...commandStart, input: { ...commandStart.input, text: 123 } },
    { ...commandCancel, commandID: null },
    { ...commandCancel, threadID: 123 },
    { ...commandCancel, runID: '' },
    { ...commandCancel, extra: true },
    { ...commandCancel, version: 0 },
    { ...commandStart, input: { text: 'hello' } },
  ]

  test.each(malformed.map((command, index) => [index, command] as const))(
    'rejects malformed wire command %i',
    (_index, command) => {
      expect(executionCommandSchema.safeParse(command).success).toBe(false)
    },
  )

  test('parsed identities and accepted input resist mutation', () => {
    const parsed = startCommandSchema.parse(commandStart)
    expect(Reflect.set(parsed, 'runID', 'another-run')).toBe(false)
    expect(Reflect.set(parsed.input, 'text', 'replacement')).toBe(false)
    expect(parsed.runID).toBe(commandStart.runID)
    expect(parsed.input.text).toBe('  Hello\nworld  ')
  })
})

test('canonicalizes UUID case without changing accepted text', () => {
  const uuid = 'ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF'
  const canonical = 'abcdefab-cdef-4abc-8def-abcdefabcdef'
  expect(
    startCommandSchema.parse({
      ...commandStart,
      commandID: uuid,
      threadID: uuid,
      runID: uuid,
      input: { messageID: uuid, text: commandStart.input.text },
    }),
  ).toEqual({
    ...commandStart,
    commandID: canonical,
    threadID: canonical,
    runID: canonical,
    input: { messageID: canonical, text: commandStart.input.text },
  })
  expect(
    cancelCommandSchema.parse({
      ...commandCancel,
      commandID: uuid,
      threadID: uuid,
      runID: uuid,
    }),
  ).toEqual({
    ...commandCancel,
    commandID: canonical,
    threadID: canonical,
    runID: canonical,
  })
})

test('asset-only starts preserve allocation references without changing legacy JSON', () => {
  const command = {
    version: 1 as const,
    kind: 'start' as const,
    commandID: crypto.randomUUID(),
    threadID: crypto.randomUUID(),
    runID: crypto.randomUUID(),
    input: {
      messageID: crypto.randomUUID(),
      text: '',
      assets: [
        {
          assetID: crypto.randomUUID(),
          objectKey: 'assets/project/object',
          name: 'photo.png',
          mimeType: 'image/png',
          byteLength: 3,
          sha256: 'a'.repeat(64),
        },
      ],
    },
  }
  expect(startCommandSchema.parse(command)).toEqual(command)
  expect(() =>
    startCommandSchema.parse({
      ...command,
      input: { ...command.input, assets: [] },
    }),
  ).toThrow()
})

const eventBase = {
  version: 1,
  eventID: '11111111-1111-4111-8111-111111111111',
  threadID: '22222222-2222-4222-8222-222222222222',
  runID: '33333333-3333-4333-8333-333333333333',
} as const
const messageID = '44444444-4444-4444-8444-444444444444'
const eventCases = [
  { ...eventBase, kind: 'run-started' },
  { ...eventBase, kind: 'assistant-text', messageID, delta: '' },
  { ...eventBase, kind: 'run-completed', messageID, text: ' Answer\n' },
  { ...eventBase, kind: 'run-cancelled' },
  { ...eventBase, kind: 'run-failed', reason: 'execution-error' },
  { ...eventBase, kind: 'run-failed', reason: 'interrupted' },
] as const

test.each([...eventCases])(
  'accepts public event $kind unchanged and immutable',
  (event) => {
    const parsed = executionEventSchema.parse(event)
    expect(parsed).toEqual(event)
    expect(Reflect.set(parsed, 'runID', 'replacement')).toBe(false)
  },
)

test('rejects private details, malformed identities and unknown versions', () => {
  const invalid: unknown[] = [null, [], {}, { ...eventBase, kind: 'tool-call' }]
  for (const event of eventCases) {
    invalid.push(
      { ...event, version: 2 },
      { ...event, eventID: 'bad' },
      { ...event, threadID: 'bad' },
      { ...event, runID: 'bad' },
      { ...event, history: [] },
      { ...event, toolArguments: {} },
      { ...event, stack: 'private' },
    )
  }
  invalid.push(
    { ...eventBase, kind: 'assistant-text', messageID: 'bad', delta: 'x' },
    { ...eventBase, kind: 'assistant-text', messageID, delta: 1 },
    { ...eventBase, kind: 'run-completed', messageID },
    { ...eventBase, kind: 'run-failed', reason: 'provider-secret' },
  )
  for (const event of invalid)
    expect(executionEventSchema.safeParse(event).success).toBe(false)
})

test('canonicalizes all public event UUIDs while preserving text', () => {
  const uuid = 'ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF'
  const canonical = 'abcdefab-cdef-4abc-8def-abcdefabcdef'
  for (const event of eventCases) {
    const input = { ...event, eventID: uuid, threadID: uuid, runID: uuid }
    const expected = {
      ...event,
      eventID: canonical,
      threadID: canonical,
      runID: canonical,
    }
    if ('messageID' in event) {
      const expectedMessageEvent = { ...expected, messageID: canonical }
      expect(executionEventSchema.parse({ ...input, messageID: uuid })).toEqual(
        expectedMessageEvent,
      )
    } else {
      expect(executionEventSchema.parse(input)).toEqual(expected)
    }
  }
})

const deliveryEvent = {
  version: 1,
  kind: 'run-started',
  eventID: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
  threadID: 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB',
  runID: 'CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC',
}

test('event deliveries carry positive integer run ordinals and canonical identities', () => {
  const parsed = executionDeliverySchema.parse({
    ordinal: 3,
    event: deliveryEvent,
  })
  expect(parsed.ordinal).toBe(3)
  expect(parsed.event.eventID).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
  for (const ordinal of [0, -1, 1.5, NaN, Infinity]) {
    expect(
      executionDeliverySchema.safeParse({ ordinal, event: deliveryEvent })
        .success,
    ).toBe(false)
  }
})

test('missing order authority and private transport payloads are rejected', () => {
  expect(
    executionDeliverySchema.safeParse({ event: deliveryEvent }).success,
  ).toBe(false)
  expect(
    executionDeliverySchema.safeParse({
      ordinal: 1,
      event: deliveryEvent,
      history: 'private',
    }).success,
  ).toBe(false)
  expect(
    executionDeliverySchema.safeParse({
      ordinal: 1,
      event: { ...deliveryEvent, tools: 'private' },
    }).success,
  ).toBe(false)
})

test('asset wire references reject caller source and completion retains absence for legacy text', () => {
  const asset = {
    assetID: crypto.randomUUID(),
    objectKey: 'assets/generated/private',
    name: '剪辑.txt',
    mimeType: 'text/plain',
    byteLength: 3,
    sha256: 'a'.repeat(64),
  }
  const completed = {
    ...eventBase,
    kind: 'run-completed',
    messageID,
    text: '',
  } as const
  expect(executionEventSchema.parse(completed)).toEqual(completed)
  expect(
    executionEventSchema.safeParse({
      ...completed,
      assets: [{ ...asset, source: 'upload' }],
    }).success,
  ).toBe(false)
  expect(executionEventSchema.parse({ ...completed, assets: [asset] })).toEqual(
    { ...completed, assets: [asset] },
  )
  expect(
    executionEventSchema.parse({
      ...eventBase,
      kind: 'run-failed',
      reason: 'sandbox-recovery-required',
    }).kind,
  ).toBe('run-failed')
  const parsed = startCommandSchema.parse({
    ...commandStart,
    input: { ...commandStart.input, assets: [asset] },
  })
  expect(Reflect.set(parsed.input.assets!, '0', asset)).toBe(false)
})

test('every closed public failure category is accepted by terminal and snapshot schemas only', () => {
  for (const reason of [
    'execution-error',
    'interrupted',
    'sandbox-recovery-required',
    'provider-secret',
  ]) {
    const valid = reason !== 'provider-secret'
    expect(
      failedRunSchema.safeParse({
        runID: commandStart.runID,
        messageID: commandStart.runID,
        reason,
      }).success,
    ).toBe(valid)
    expect(
      executionEventSchema.safeParse({
        version: 1,
        kind: 'run-failed',
        eventID: commandStart.runID,
        threadID: commandStart.runID,
        runID: commandStart.runID,
        reason,
      }).success,
    ).toBe(valid)
  }
})
