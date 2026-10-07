import { expect, test } from 'bun:test'
import { modelStream } from './model-stream-fixture'

test('model framing retains distinct caller envelopes and exactly one trailing DONE', async () => {
  const envelopes = Object.freeze([
    Object.freeze({
      id: 'first',
      object: 'chat.completion.chunk',
      choices: [],
    }),
    Object.freeze({ id: 'second', model: 'caller-model', choices: [] }),
  ])
  const response = modelStream(envelopes)
  expect(response.headers.get('content-type')).toBe('text/event-stream')
  expect(await response.text()).toBe(
    'data: {"id":"first","object":"chat.completion.chunk","choices":[]}\n\n' +
      'data: {"id":"second","model":"caller-model","choices":[]}\n\n' +
      'data: [DONE]\n\n',
  )
  expect(envelopes).toEqual([
    { id: 'first', object: 'chat.completion.chunk', choices: [] },
    { id: 'second', model: 'caller-model', choices: [] },
  ])
})
