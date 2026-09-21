import { EventType } from '@ag-ui/core'
import { expect, test } from 'bun:test'
import {
  changeEvents,
  snapshotEvents,
} from '../../apps/server/src/modules/conversation/presentation/http/history'
import { advance, nothingYet } from '../../apps/web/src/features/conversation/transcript'

test('a fresh snapshot restores unfinished text and accepts subsequent deltas', async () => {
  const events = await snapshotEvents(
    {
      cursor: '4',
      activeTurnID: 'run',
      messages: [
        { id: 'answer', kind: 'text', author: 'assistant', text: 'Hello', finished: false },
      ],
    },
    async (key) => key,
    'thread',
  )

  const restored = events.reduce(advance, nothingYet)
  const continued = advance(restored, {
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId: 'answer',
    delta: ' world',
  })

  expect(continued.items).toEqual([
    { id: 'answer', kind: 'said', from: 'agent', text: 'Hello world', finished: false },
  ])
  expect(continued.working).toBe(true)
})

test('artifact keys are signed on each read and never exposed', async () => {
  const snapshot = {
    cursor: '1',
    activeTurnID: null,
    messages: [
      {
        id: 'video',
        kind: 'activity' as const,
        activity: { kind: 'artifact' as const, key: 'private/output', role: 'final' as const },
      },
    ],
  }

  const first = await snapshotEvents(snapshot, async () => 'https://objects/first', 'thread')
  const second = await snapshotEvents(snapshot, async () => 'https://objects/second', 'thread')

  expect(JSON.stringify(first)).toContain('https://objects/first')
  expect(JSON.stringify(second)).toContain('https://objects/second')
  expect(JSON.stringify(second)).not.toContain('private/output')
})

test('a failed execution never discloses adapter diagnostics', async () => {
  const events = await changeEvents(
    { kind: 'finished', turnID: 'run', outcome: 'failed', reason: 'secret provider response' },
    async (key) => key,
    'thread',
  )

  expect(events[0]?.type).toBe(EventType.RUN_ERROR)
  expect(JSON.stringify(events)).not.toContain('secret provider response')
})

test.each(['succeeded', 'cancelled'] as const)(
  '%s ends the browser working state',
  async (outcome) => {
    const events = await changeEvents(
      { kind: 'finished', turnID: 'run', outcome, reason: null },
      async (key) => key,
      'thread',
    )
    const completed = events.reduce(advance, { ...nothingYet, working: true })

    expect(events).toEqual([{ type: EventType.RUN_FINISHED, threadId: 'thread', runId: 'run' }])
    expect(completed.working).toBe(false)
  },
)

test('a user message echoed by the server replaces the optimistic message', async () => {
  const optimistic = {
    ...nothingYet,
    items: [
      {
        kind: 'said' as const,
        id: 'input:asked',
        from: 'person' as const,
        text: 'Hello',
        finished: true,
      },
    ],
  }

  const events = await changeEvents(
    {
      kind: 'message',
      message: { id: 'input:asked', kind: 'text', author: 'user', text: 'Hello', finished: true },
    },
    async (key) => key,
    'thread',
  )

  expect(events.reduce(advance, optimistic).items).toEqual(optimistic.items)
})

test('live reasoning restores in its own channel without an empty assistant reply', async () => {
  const events = await snapshotEvents(
    {
      cursor: '2',
      activeTurnID: 'run',
      messages: [
        {
          id: 'thinking',
          kind: 'text',
          author: 'reasoning',
          text: 'Choosing a shot',
          finished: false,
        },
      ],
    },
    async (key) => key,
    'thread',
  )

  expect(events.reduce(advance, nothingYet).items).toEqual([
    { id: 'thinking', kind: 'thought', text: 'Choosing a shot', finished: false },
  ])
})

test('an activity update gives the browser a signed link rather than a storage key', async () => {
  const events = await changeEvents(
    {
      kind: 'message',
      message: {
        id: 'video',
        kind: 'activity',
        activity: { kind: 'artifact', key: 'private/video.mp4', role: 'final' },
      },
    },
    async () => 'https://objects/signed-video',
    'thread',
  )

  expect(events.reduce(advance, nothingYet).items).toEqual([
    { kind: 'artifact', id: 'video', url: 'https://objects/signed-video', role: 'final' },
  ])
})
