/**
 * The promise here is narrow and absolute: a person never sees the model's private working.
 *
 * Some gateways inline reasoning into message text instead of sending it on the reasoning
 * channel. Deltas are split at arbitrary points, so the block can straddle any number of
 * them -- which is why every split point of a real message is checked rather than a few
 * chosen ones.
 */
import { describe, expect, test } from 'bun:test'
import { createThinkingFilter } from './pi-events'

const through = (chunks: readonly string[]): string => {
  const visible = createThinkingFilter()
  return chunks.map(visible).join('')
}

describe('reasoning inlined into message text', () => {
  test('ordinary text is untouched', () => {
    expect(through(['hello ', 'world'])).toBe('hello world')
  })

  test('a block in one delta leaves nothing behind', () => {
    expect(through(['before <thinking>secret</thinking> after'])).toBe('before  after')
  })

  test('a block spread across deltas leaves nothing behind', () => {
    expect(through(['before <thin', 'king>sec', 'ret</thin', 'king> after'])).toBe('before  after')
  })

  test('two blocks in one message both go', () => {
    expect(through(['a<thinking>x</thinking>b<thinking>y</thinking>c'])).toBe('abc')
  })

  test('a block that never closes swallows the rest rather than leaking it', () => {
    expect(through(['visible<thinking>never closed'])).toBe('visible')
  })

  test('text that merely looks like a tag survives', () => {
    expect(through(['a < b and c > d'])).toBe('a < b and c > d')
  })

  const message = 'The render is done.<thinking>**Checking metadata**</thinking>It plays.'
  const visible = 'The render is done.It plays.'

  test('every split point of a real message', () => {
    const leaked: string[] = []
    for (let at = 1; at < message.length; at++) {
      const got = through([message.slice(0, at), message.slice(at)])
      if (got !== visible) leaked.push(`split at ${at}: ${JSON.stringify(got)}`)
    }

    expect(leaked).toEqual([])
  })

  test('one character at a time', () => {
    expect(through([...message])).toBe(visible)
  })
})
