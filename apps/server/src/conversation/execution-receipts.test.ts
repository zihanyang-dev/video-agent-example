import { expect, test } from 'bun:test'
import { publicEvent } from './execution-receipts'

const completion = {
  version: 1 as const,
  kind: 'run-completed' as const,
  eventID: 'd1000000-0000-4000-8000-000000000001',
  threadID: 'd1000000-0000-4000-8000-000000000002',
  runID: 'd1000000-0000-4000-8000-000000000003',
  messageID: 'd1000000-0000-4000-8000-000000000004',
  text: 'Final answer',
}

test('completion receipt retains only validated owned sources', () => {
  const sources = [{ title: 'Official documentation', url: 'https://pi.dev/docs/latest/sdk' }]
  const fact = { ...completion, sources, privateHistory: 'not public' }
  expect(publicEvent(fact)).toEqual({ ...completion, sources })
})

test('completion omits undefined optional fields instead of adding public keys', () => {
  const projected = publicEvent({
    ...completion,
    assets: undefined,
    sources: undefined,
  })
  expect(projected).toEqual(completion)
  expect(Object.hasOwn(projected, 'assets')).toBe(false)
  expect(Object.hasOwn(projected, 'sources')).toBe(false)
})

test('completion retains explicit empty metadata from a frozen receipt', () => {
  const fact = Object.freeze({
    ...completion,
    assets: Object.freeze([]),
    sources: Object.freeze([]),
  })
  expect(publicEvent(fact)).toEqual({ ...completion, assets: [], sources: [] })
  expect(fact.assets).toHaveLength(0)
  expect(fact.sources).toHaveLength(0)
})

test('completion receipt refuses private or unsafe source fields', () => {
  for (const source of [
    { title: 'Secret', url: 'https://pi.dev/?token=private' },
    { title: 'Internal', url: 'https://localhost/private' },
    {
      title: 'Snippet',
      url: 'https://pi.dev/',
      snippet: 'private tool evidence',
    },
  ])
    expect(() => publicEvent({ ...completion, sources: [source] })).toThrow()
})

test('receipt projection normalizes public identities without retaining private envelope fields', () => {
  const fact = {
    version: 1 as const,
    kind: 'assistant-text' as const,
    eventID: 'D1000000-0000-4000-8000-000000000001',
    threadID: 'D1000000-0000-4000-8000-000000000002',
    runID: 'D1000000-0000-4000-8000-000000000003',
    messageID: 'D1000000-0000-4000-8000-000000000004',
    delta: 'Exact text',
    operatorToken: 'private-fixture-token',
  }
  expect(publicEvent(fact)).toEqual({
    version: 1,
    kind: 'assistant-text',
    eventID: 'd1000000-0000-4000-8000-000000000001',
    threadID: 'd1000000-0000-4000-8000-000000000002',
    runID: 'd1000000-0000-4000-8000-000000000003',
    messageID: 'd1000000-0000-4000-8000-000000000004',
    delta: 'Exact text',
  })
})
