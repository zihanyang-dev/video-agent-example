import { expect, test } from 'bun:test'
import { sandboxReferenceFromJSON } from './reference'

test('no persisted native environment is distinct from malformed identity', () => {
  expect(sandboxReferenceFromJSON(null)).toBeUndefined()
  for (const value of [
    undefined,
    [],
    'sandbox',
    {},
    { provider: 'e2b' },
    { id: 'native' },
    { provider: '', id: 'native' },
    { provider: 'e2b', id: 1 },
  ])
    expect(() => sandboxReferenceFromJSON(value)).toThrow()
})

test('persisted provider identities preserve opaque identifiers without accepting undeclared state', () => {
  expect(
    sandboxReferenceFromJSON({
      provider: 'future-provider',
      id: 'Native/ID:CaseSensitive',
    }),
  ).toEqual({ provider: 'future-provider', id: 'Native/ID:CaseSensitive' })
  expect(() => sandboxReferenceFromJSON({ provider: 'e2b', id: 'native', memory: true })).toThrow()
})

test('the validated persisted reference cannot change after lease authorization', () => {
  const reference = sandboxReferenceFromJSON({ provider: 'e2b', id: 'native' })
  if (!reference) throw new Error('Expected persisted reference')
  expect(Reflect.set(reference, 'id', 'another-environment')).toBe(false)
  expect(reference.id).toBe('native')
})
