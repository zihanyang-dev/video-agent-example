import { expect, test } from 'bun:test'
import { z } from 'zod'
import Ajv from 'ajv/dist/2020'
import { normalizeWebSource, webSourceSchema, webSourcesSchema } from './web-source'

const source = { title: 'Public source', url: 'https://example.org/source' }
const badURLs = [
  'http://example.org/',
  'javascript:alert(1)',
  'https://127.0.0.1/',
  'https://8.8.8.8/',
  'https://2130706433/',
  'https://0x7f000001/',
  'https://[2606:4700::1111]/',
  'https://[::ffff:127.0.0.1]/',
  'https://localhost./',
  'https://private.internal/',
  'https://host.local/',
  'https://intranet/',
  'https://user:pass@example.org/',
  'https://example.org/#fragment',
  'https://example.org/?api_key=CANARY',
  'https://example.org/?%74oken=CANARY',
  'https://example.org/?SESSION=CANARY',
  'https://example.org/\npath',
  'https://example.org/%00',
  'https://example.org\\@private.internal/',
]

test('strict source facts reject unsafe URLs in runtime and exported JSON Schema', () => {
  const validate = new Ajv({ strict: false }).compile(z.toJSONSchema(webSourceSchema))
  expect(webSourceSchema.parse(source)).toEqual(source)
  expect(validate(source)).toBe(true)
  for (const url of badURLs) {
    expect(webSourceSchema.safeParse({ ...source, url }).success).toBe(false)
    expect(validate({ ...source, url })).toBe(false)
  }
  for (const extra of ['snippet', 'query', 'args', 'history', 'key', 'runID']) {
    const input = { ...source, [extra]: 'PRIVATE CANARY' }
    expect(webSourceSchema.safeParse(input).success).toBe(false)
    expect(validate(input)).toBe(false)
  }
})

test('source titles and turn bounds are strict and readonly', () => {
  for (const title of [
    '',
    ' ',
    '<script>CANARY</script>',
    'bad\u0000',
    'bad\u202e',
    '\ud800',
    'x'.repeat(257),
  ])
    expect(webSourceSchema.safeParse({ ...source, title }).success).toBe(false)
  expect(webSourcesSchema.safeParse(Array(16).fill(source)).success).toBe(false)
  expect(Object.isFrozen(webSourcesSchema.parse([source]))).toBe(true)
  expect(Object.isFrozen(webSourceSchema.parse(source))).toBe(true)
})

test('shared normalization preserves only strict admitted facts within serialized URL bounds', () => {
  expect(normalizeWebSource({ title: 'Found', url: 'https://example.org' })).toEqual({
    title: 'Found',
    url: 'https://example.org/',
  })
  expect(normalizeWebSource({ ...source, snippet: 'PRIVATE CANARY' })).toBeUndefined()
  expect(
    normalizeWebSource({
      ...source,
      url: `https://example.org/${'中'.repeat(1000)}`,
    }),
  ).toBeUndefined()
})
