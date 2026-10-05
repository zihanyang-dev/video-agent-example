import { expect, test } from 'bun:test'
import { EventType, HttpAgent } from '@ag-ui/client'
import { runEventsURL } from './run-endpoint'
import { emptyRunView, reduceRunEvent, pendingTranscript } from './run-view'

const messageID = '22222222-2222-4222-8222-222222222222'
const threadID = '11111111-1111-4111-8111-111111111111'
const runID = '33333333-3333-4333-8333-333333333333'

test('partial replay is immutable and only a complete fact advances the reconnect cursor', () => {
  const previous = emptyRunView()
  const frame = {
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId: messageID,
    delta: 'Draft',
    metadata: { eventID: 'fact:0', factID: 'fact' },
  }
  const partial = reduceRunEvent(previous, frame)
  expect(previous.messages).toEqual([])
  expect(previous.seen.size).toBe(0)
  expect(partial.after).toBe('0')
  expect(reduceRunEvent(partial, frame)).toBe(partial)
  const complete = reduceRunEvent(partial, {
    type: EventType.TEXT_MESSAGE_END,
    messageId: messageID,
    metadata: { eventID: 'fact:1', cursor: '12' },
  })
  expect(complete.after).toBe('12')
  expect(
    pendingTranscript(
      [
        {
          messageID,
          role: 'assistant',
          text: 'Canonical correction',
          createdAt: '2026-10-04T00:00:00.000Z',
        },
      ],
      complete,
    ),
  ).toEqual([])
})

test('official AG-UI client parses real frames and never sends model history', async () => {
  let view = emptyRunView()
  const bodies: unknown[] = []
  const agent = new HttpAgent({
    url: await runEventsURL({ threadID, runID }),
    threadId: threadID,
    async fetch(url, init) {
      expect(new URL(url).pathname).toBe(
        `/api/threads/${threadID}/runs/${runID}/events`,
      )
      if (typeof init?.body !== 'string') throw new Error('Expected JSON')
      bodies.push(JSON.parse(init.body))
      return new Response(
        `data: ${JSON.stringify({ type: EventType.RUN_STARTED, threadId: threadID, runId: runID })}\n\ndata: ${JSON.stringify({ type: EventType.TEXT_MESSAGE_START, messageId: messageID, role: 'assistant' })}\n\ndata: ${JSON.stringify({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: messageID, delta: 'Hello', metadata: { eventID: 'fact:0', cursor: '1' } })}\n\ndata: ${JSON.stringify({ type: EventType.TEXT_MESSAGE_END, messageId: messageID })}\n\ndata: ${JSON.stringify({ type: EventType.RUN_FINISHED, threadId: threadID, runId: runID, metadata: { eventID: 'final:0', cursor: '2' } })}\n\n`,
        { headers: { 'Content-Type': 'text/event-stream' } },
      )
    },
  })
  await agent.runAgent(
    { runId: runID, forwardedProps: { after: view.after } },
    {
      onEvent({ event }) {
        view = reduceRunEvent(view, event)
      },
    },
  )
  expect(view.messages[0]?.text).toBe('Hello')
  expect(view.terminal).toBe(true)
  expect(bodies[0]).toMatchObject({
    messages: [],
    tools: [],
    state: {},
    forwardedProps: { after: '0' },
  })
})

test('an observer error without a durable identity is not an execution terminal fact', () => {
  const view = reduceRunEvent(emptyRunView(), {
    type: EventType.RUN_ERROR,
    message: 'private diagnostic',
  })
  expect(view.terminal).toBe(false)
})

test('a durable public run failure retains the user recovery message', () => {
  const view = reduceRunEvent(emptyRunView(), {
    type: EventType.RUN_ERROR,
    message: 'The run was interrupted. Start a new message when ready.',
    metadata: { eventID: 'terminal:0', cursor: '3' },
  })
  expect(view).toMatchObject({
    terminal: true,
    error: 'The run was interrupted. Start a new message when ready.',
  })
})
