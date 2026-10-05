import { expect, test } from 'bun:test'
import { EventType } from '@ag-ui/core'
import { EventSchema } from '@ag-ui/core/schemas'
import { mapPublicRunEvent, type PublicRunState } from './public-run-events'

const initial: PublicRunState = {
  started: false,
  terminal: false,
  messages: new Map(),
}
const base = {
  version: 1,
  eventID: crypto.randomUUID(),
  threadID: crypto.randomUUID(),
  runID: crypto.randomUUID(),
} as const
const messageID = crypto.randomUUID()

test('completion suffix does not append already streamed text twice', () => {
  const first = mapPublicRunEvent(initial, {
    ...base,
    kind: 'assistant-text',
    messageID,
    delta: 'Hello',
  })
  expect(first.frames.map((frame) => frame.type)).toEqual([
    EventType.RUN_STARTED,
    EventType.TEXT_MESSAGE_START,
    EventType.TEXT_MESSAGE_CONTENT,
  ])
  const last = mapPublicRunEvent(first.state, {
    ...base,
    eventID: crypto.randomUUID(),
    kind: 'run-completed',
    messageID,
    text: 'Hello world',
  })
  const events = [...first.frames, ...last.frames].map((event) =>
    EventSchema.parse(event),
  )
  expect(
    events
      .filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)
      .map((event) => event.delta)
      .join(''),
  ).toBe('Hello world')
  expect(
    events.filter((event) => event.type === EventType.TEXT_MESSAGE_START),
  ).toHaveLength(1)
  expect(last.state.terminal).toBe(true)
  expect(first.state.messages.get(messageID)).toBe('Hello')
  expect(initial.messages.size).toBe(0)
})

test('zero-delta completion emits the whole answer and stable frame identities', () => {
  const fact = {
    ...base,
    kind: 'run-completed',
    messageID,
    text: 'Answer',
  } as const
  const first = mapPublicRunEvent(initial, fact).frames
  expect(mapPublicRunEvent(initial, fact).frames).toEqual(first)
  expect(first[0]?.metadata).toEqual({
    mappingVersion: 'ag-ui-1.0.1-v1',
    eventID: `${fact.eventID}:RUN_STARTED:`,
    factID: fact.eventID,
  })
  expect(
    first.filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT),
  ).toMatchObject([{ delta: 'Answer' }])
  expect(first.at(-1)?.type).toBe(EventType.RUN_FINISHED)
  for (const event of first)
    expect(EventSchema.safeParse(event).success).toBe(true)
})

test.each(['run-cancelled', 'run-failed'] as const)(
  'prestart %s emits official schema-compatible terminal frames',
  (kind) => {
    const mapped = mapPublicRunEvent(
      initial,
      kind === 'run-failed'
        ? { ...base, kind, reason: 'execution-error' }
        : { ...base, kind },
    )
    expect(mapped.frames[0]?.type).toBe(EventType.RUN_STARTED)
    expect(mapped.frames.at(-1)?.type).toBe(
      kind === 'run-failed' ? EventType.RUN_ERROR : EventType.RUN_FINISHED,
    )
    for (const frame of mapped.frames)
      expect(EventSchema.safeParse(frame).success).toBe(true)
    expect(mapped.state.terminal).toBe(true)
  },
)

test('public failure explains recovery without exposing the owner reason as prose', () => {
  const mapped = mapPublicRunEvent(initial, {
    ...base,
    kind: 'run-failed',
    reason: 'interrupted',
  })
  expect(mapped.frames.at(-1)).toMatchObject({
    type: EventType.RUN_ERROR,
    code: 'interrupted',
    message:
      'The run was interrupted. Check Chat history and ask the operator to verify the execution environment before retrying.',
  })
})

test('non-prefix completion does not append a conflicting canonical answer', () => {
  const draft = mapPublicRunEvent(initial, {
    ...base,
    kind: 'assistant-text',
    messageID,
    delta: 'Draft',
  })
  const final = mapPublicRunEvent(draft.state, {
    ...base,
    kind: 'run-completed',
    messageID,
    text: 'Final',
  })
  expect(
    final.frames.some((frame) => frame.type === EventType.TEXT_MESSAGE_CONTENT),
  ).toBe(false)
  expect(final.frames.at(-1)?.type).toBe(EventType.RUN_FINISHED)
  expect(final.state.messages.get(messageID)).toBe('Final')
})

test('content dedup identity is independent of reconstructed lifecycle frames', () => {
  const fact = {
    ...base,
    kind: 'assistant-text',
    messageID,
    delta: 'next',
  } as const
  const fresh = mapPublicRunEvent(initial, fact).frames.find(
    (frame) => frame.type === EventType.TEXT_MESSAGE_CONTENT,
  )
  const resumed = mapPublicRunEvent(
    {
      started: true,
      terminal: false,
      messages: new Map([[messageID, 'prior']]),
    },
    fact,
  ).frames.find((frame) => frame.type === EventType.TEXT_MESSAGE_CONTENT)
  expect(fresh?.metadata).toEqual(resumed?.metadata)
})
