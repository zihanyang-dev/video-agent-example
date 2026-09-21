/**
 * What a person ends up looking at.
 *
 * The cases here are the ones a browser makes hard to reproduce on purpose: a reply
 * arriving in fragments, a step settling long after it started, and a reconnect landing in
 * the middle of both.
 */
import { EventType, type Event, type Message } from '@ag-ui/core'
import { ARTIFACT, STEP } from '@vid/contract'
import { describe, expect, test } from 'bun:test'
import { advance, latestFinal, nothingYet, type Transcript } from './transcript'

const after = (...events: readonly Event[]): Transcript => events.reduce(advance, nothingYet)

const says = (id: string, ...deltas: readonly string[]): Event[] => [
  { type: EventType.TEXT_MESSAGE_START, messageId: id, role: 'assistant' },
  ...deltas.map((delta): Event => ({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: id, delta })),
  { type: EventType.TEXT_MESSAGE_END, messageId: id },
]

const step = (id: string, label: string, state: string): Event =>
  ({
    type: EventType.ACTIVITY_SNAPSHOT,
    messageId: id,
    activityType: STEP,
    content: { label, state },
  }) as Event

describe('a reply arriving in fragments', () => {
  test('reads as one thing, not as its pieces', () => {
    const transcript = after(...says('m1', 'A slow ', 'drift across ', 'the water.'))

    expect(transcript.items).toEqual([
      {
        kind: 'said',
        id: 'm1',
        from: 'agent',
        text: 'A slow drift across the water.',
        finished: true,
      },
    ])
  })

  test('is readable before it has finished', () => {
    const transcript = after(
      { type: EventType.TEXT_MESSAGE_START, messageId: 'm1', role: 'assistant' },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'm1', delta: 'A slow ' },
    )

    expect(transcript.items[0]).toMatchObject({ text: 'A slow ', finished: false })
  })
})

describe('a step', () => {
  test('is one row that changes, not a row per update', () => {
    const transcript = after(
      step('s1', 'Generating footage', 'running'),
      step('s1', 'Generating footage', 'done'),
    )

    expect(transcript.items).toHaveLength(1)
    expect(transcript.items[0]).toMatchObject({ state: 'done' })
  })

  test('stays where it started, so settling does not move it past what was said since', () => {
    const transcript = after(
      step('s1', 'Generating footage', 'running'),
      ...says('m1', 'This will take a few minutes.'),
      step('s1', 'Generating footage', 'done'),
    )

    expect(transcript.items.map((item) => item.id)).toEqual(['s1', 'm1'])
  })
})

const snapshot = (messages: readonly Message[]): Event => ({
  type: EventType.MESSAGES_SNAPSHOT,
  messages: [...messages],
})

const snapshotOf = (id: string, content: string): Event =>
  snapshot([{ id, role: 'assistant', content }])

describe('a reconnect', () => {
  test('replaces what is on screen rather than adding to it', () => {
    const transcript = after(
      ...says('m1', 'half a repl'),
      snapshot([{ id: 'm1', role: 'assistant', content: 'half a reply, finished' }]),
    )

    expect(transcript.items).toEqual([
      { kind: 'said', id: 'm1', from: 'agent', text: 'half a reply, finished', finished: true },
    ])
  })

  test('does not show the tail of a reply twice when the stream replays it', () => {
    const transcript = after(
      snapshot([{ id: 'm1', role: 'assistant', content: 'the whole reply' }]),
      // The cursor landed mid-reply, so these arrive for a message already complete.
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'm2', delta: ' reply' },
    )

    expect(transcript.items).toHaveLength(1)
    expect(transcript.items[0]).toMatchObject({ text: 'the whole reply' })
  })

  test('replaying the stream that built the snapshot changes nothing', () => {
    const conversation: Event[] = [
      ...says('m1', 'A slow ', 'drift.'),
      step('s1', 'Generating footage', 'done'),
    ]

    // What a page load actually receives: the snapshot, then the events it was built from.
    const loaded = after(
      ...conversation,
      snapshot([
        { id: 'm1', role: 'assistant', content: 'A slow drift.' },
        {
          id: 's1',
          role: 'activity',
          activityType: STEP,
          content: { label: 'Generating footage', state: 'done' },
        } as unknown as Message,
      ]),
      ...conversation,
    )

    expect(loaded.items).toEqual(after(...conversation).items)
  })

  test('keeps building a reply whose beginning it missed', () => {
    const transcript = after(snapshot([]), ...says('m1', 'the rest of it'))

    expect(transcript.items).toEqual([
      { kind: 'said', id: 'm1', from: 'agent', text: 'the rest of it', finished: true },
    ])
  })
})

describe('a page load', () => {
  test('does not append the tail of a reply the snapshot already finished', () => {
    const transcript = after(
      snapshotOf('m1', 'A slow drift across the water.'),
      // What a cursor landing mid-reply replays: the tail, with no START in front of it.
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'm1', delta: 'across the water.' },
    )

    expect(transcript.items[0]).toMatchObject({ text: 'A slow drift across the water.' })
  })

  test('brings back what someone asked for, not just what was answered', () => {
    const transcript = after(
      snapshot([
        { id: 'u1', role: 'user', content: 'make me an opener' },
        { id: 'm1', role: 'assistant', content: 'here it is' },
      ]),
    )

    expect(transcript.items.map((item) => item.kind === 'said' && item.from)).toEqual([
      'person',
      'agent',
    ])
  })
})

describe('what the turn is doing', () => {
  test('is working between starting and finishing', () => {
    expect(after({ type: EventType.RUN_STARTED, threadId: 't1', runId: 'r1' }).working).toBe(true)
  })

  test('stops working when it finishes', () => {
    const transcript = after(
      { type: EventType.RUN_STARTED, threadId: 't1', runId: 'r1' },
      { type: EventType.RUN_FINISHED, threadId: 't1', runId: 'r1' },
    )

    expect(transcript.working).toBe(false)
  })

  test('shows what broke, and stops claiming to be working', () => {
    const transcript = after(
      { type: EventType.RUN_STARTED, threadId: 't1', runId: 'r1' },
      { type: EventType.RUN_ERROR, message: 'the model refused' },
    )

    expect(transcript).toMatchObject({ working: false, broke: 'the model refused' })
  })

  test('clears the last failure when the next turn starts', () => {
    const transcript = after(
      { type: EventType.RUN_ERROR, message: 'the model refused' },
      { type: EventType.RUN_STARTED, threadId: 't1', runId: 'r2' },
    )

    expect(transcript.broke).toBeNull()
  })
})

describe('thinking', () => {
  const thinks = (id: string, text: string): Event[] => [
    { type: EventType.REASONING_MESSAGE_START, messageId: id, role: 'reasoning' },
    { type: EventType.REASONING_MESSAGE_CONTENT, messageId: id, delta: text },
    { type: EventType.REASONING_MESSAGE_END, messageId: id },
  ]

  test('is visible while the turn it belongs to is running', () => {
    const transcript = after(
      { type: EventType.RUN_STARTED, threadId: 't1', runId: 'r1' },
      ...thinks('r1', 'the title should land on the water'),
    )

    expect(transcript.items).toHaveLength(1)
    expect(transcript.items[0]).toMatchObject({ kind: 'thought' })
  })

  test('goes away when the turn ends, because it is not part of the record', () => {
    const transcript = after(
      { type: EventType.RUN_STARTED, threadId: 't1', runId: 'r1' },
      ...thinks('r1', 'the title should land on the water'),
      ...says('m1', 'Done.'),
      { type: EventType.RUN_FINISHED, threadId: 't1', runId: 'r1' },
    )

    expect(transcript.items).toEqual([
      { kind: 'said', id: 'm1', from: 'agent', text: 'Done.', finished: true },
    ])
  })

  test('does not pile up at the bottom of a conversation that is over', () => {
    const past: Event[] = [
      { type: EventType.RUN_STARTED, threadId: 't1', runId: 'r1' },
      ...thinks('r1', 'a'),
      ...says('m1', 'Done.'),
      { type: EventType.RUN_FINISHED, threadId: 't1', runId: 'r1' },
    ]

    // A page load: the snapshot, then the stream that built it replayed.
    const loaded = after(...past, snapshotOf('m1', 'Done.'), ...past)

    expect(loaded.items.filter((item) => item.kind === 'thought')).toEqual([])
  })
})

describe('the stage', () => {
  const artifact = (id: string, url: string, role: string): Event =>
    ({
      type: EventType.ACTIVITY_SNAPSHOT,
      messageId: id,
      activityType: ARTIFACT,
      content: { url, role },
    }) as Event

  test('shows the most recent finished cut', () => {
    const transcript = after(
      artifact('a1', 'https://objects/first', 'final'),
      artifact('a2', 'https://objects/second', 'final'),
    )

    expect(latestFinal(transcript)).toMatchObject({ url: 'https://objects/second' })
  })

  test('is not taken over by a rough preview', () => {
    const transcript = after(
      artifact('a1', 'https://objects/cut', 'final'),
      artifact('a2', 'https://objects/rough', 'preview'),
    )

    expect(latestFinal(transcript)).toMatchObject({ url: 'https://objects/cut' })
  })

  test('is empty before anything has been delivered', () => {
    expect(latestFinal(after(...says('m1', 'working on it')))).toBeNull()
  })
})

describe('an activity whose shape is wrong', () => {
  const malformed = (content: unknown): Event =>
    ({
      type: EventType.ACTIVITY_SNAPSHOT,
      messageId: 's1',
      activityType: STEP,
      content,
    }) as Event

  test('is dropped rather than stringified onto the screen', () => {
    // `String({})` is `[object Object]`, and that is what used to reach the label.
    const transcript = after(malformed({ label: { nested: 'oops' }, state: 'done' }))

    expect(transcript.items).toEqual([])
  })

  test('is dropped when a required field is missing', () => {
    expect(after(malformed({ state: 'done' })).items).toEqual([])
  })

  test('does not take the rest of the conversation with it', () => {
    const transcript = after(...says('m1', 'still here'), malformed({ label: 42, state: 'done' }))

    expect(transcript.items).toHaveLength(1)
  })
})

describe('what a person is never shown', () => {
  test('a tool call is not a thing on the screen', () => {
    const transcript = after({
      type: EventType.TOOL_CALL_START,
      toolCallId: 'c1',
      toolCallName: 'bash',
    })

    expect(transcript.items).toEqual([])
  })
})
