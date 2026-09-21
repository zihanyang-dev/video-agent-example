import { expect, test } from 'bun:test'
import { createTokenReader, mintTurnToken } from './turn-token'

const secret = 'test-signing-secret-for-turn-tokens'
const read = createTokenReader(secret, () => 100)

test('the signed claims preserve the turn and thread identity', async () => {
  const token = await mintTurnToken(secret, { turnID: 'turn', threadID: 'thread' }, 100)
  expect(await read(`Bearer ${token}`)).toMatchObject({ turnID: 'turn', threadID: 'thread' })
})

test.each([
  ['invalid JSON', '{'],
  ['null claims', 'null'],
  ['missing claims', '{}'],
  ['empty thread', '{"turnID":"turn","threadID":"","expiresAt":200}'],
  ['invalid expiration', '{"turnID":"turn","threadID":"thread","expiresAt":"later"}'],
])('valid signatures do not authorize %s', async (_case, body) => {
  const encoded = Buffer.from(body).toString('base64url')
  const signature = new Bun.CryptoHasher('sha256', secret).update(encoded).digest('base64url')
  expect(await read(`${encoded}.${signature}`)).toBeNull()
})
