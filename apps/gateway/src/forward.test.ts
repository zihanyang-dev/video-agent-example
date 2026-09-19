/**
 * The gateway is what stands between a command the model wrote and the money it can spend.
 *
 * Every case here is a way that could fail: the real credential reaching the sandbox, a
 * turn's token reaching a provider, a forged or expired token buying anything, or a refused
 * call being counted as spending.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createForwarder, type TurnToken } from './forward'
import { createTokenReader, mintTurnToken } from './turn-token'

const SECRET = 'a'.repeat(48)
const REAL_KEY = 'the-real-provider-key'

let clock = Date.now()
const spends: string[] = []

/** Reports exactly what reached it, so the test can see what the gateway sent. */
const provider = Bun.serve({
  port: 0,
  fetch: async (request) => {
    const url = new URL(request.url)
    return Response.json({
      method: request.method,
      path: url.pathname,
      search: url.search,
      credential: request.headers.get('x-provider-key'),
      turnToken: request.headers.get('authorization'),
      body: request.body === null ? null : await request.text(),
    })
  },
})

const gateway = Bun.serve({
  port: 0,
  fetch: createForwarder({
    providers: {
      seedance: {
        baseUrl: `http://localhost:${provider.port}`,
        header: 'x-provider-key',
        key: REAL_KEY,
      },
    },
    readToken: createTokenReader(SECRET, () => clock),
    onSpend: (token, name, path) => spends.push(`${token.turnID} ${name}${path}`),
  }).fetch,
})

let token = ''

beforeAll(async () => {
  token = await mintTurnToken(SECRET, { turnID: 'turn-1', threadID: 't1' }, clock)
})

afterAll(() => {
  provider.stop()
  gateway.stop()
})

const call = (path: string, init: RequestInit = {}): Promise<Response> =>
  fetch(`http://localhost:${gateway.port}${path}`, init)

const withToken = (value = token): RequestInit => ({
  headers: { authorization: `Bearer ${value}`, 'content-type': 'application/json' },
})

describe('a call a skill script is allowed to make', () => {
  test('arrives at the provider with the real credential attached', async () => {
    const response = await call('/seedance/v1/generations?size=1080p', {
      ...withToken(),
      method: 'POST',
      body: JSON.stringify({ prompt: 'a drone shot' }),
    })
    const seen = (await response.json()) as Record<string, unknown>

    expect(response.status).toBe(200)
    expect(seen).toMatchObject({
      credential: REAL_KEY,
      method: 'POST',
      path: '/v1/generations',
      search: '?size=1080p',
    })
    expect(String(seen['body'])).toContain('a drone shot')
  })

  test('does not carry the turn token any further', async () => {
    const response = await call('/seedance/v1/x', withToken())

    const seen = (await response.json()) as { turnToken: string | null }
    expect(seen.turnToken).toBeNull()
  })

  test('is attributed to the turn that made it', async () => {
    await call('/seedance/v1/generations', withToken())

    expect(spends).toContain('turn-1 seedance/v1/generations')
  })
})

describe('a call that must not spend anything', () => {
  test.each([
    ['no token at all', undefined],
    ['a token that is not one of ours', 'nonsense'],
  ])('%s is refused', async (_name, presented) => {
    const response = await call(
      '/seedance/v1/x',
      presented === undefined ? {} : withToken(presented),
    )

    expect(response.status).toBe(401)
  })

  test('a forged signature is refused', async () => {
    const [payload] = token.split('.')

    const response = await call('/seedance/v1/x', withToken(`${payload}.${'A'.repeat(43)}`))

    expect(response.status).toBe(401)
  })

  test('claims edited under a signature we did write are refused', async () => {
    const stolen = token.split('.')[1]
    const rewritten = btoa(
      JSON.stringify({ turnID: 'someone-else', threadID: 't9', expiresAt: clock + 1e6 }),
    )
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '')

    const response = await call('/seedance/v1/x', withToken(`${rewritten}.${stolen}`))

    expect(response.status).toBe(401)
  })

  test('a token whose turn is long over is refused', async () => {
    clock += 2 * 60 * 60 * 1000
    const response = await call('/seedance/v1/x', withToken())
    clock -= 2 * 60 * 60 * 1000

    expect(response.status).toBe(401)
  })

  test('nothing refused is recorded as spending', async () => {
    const before = spends.length

    await call('/seedance/v1/x', withToken('nonsense'))

    expect(spends).toHaveLength(before)
  })
})

describe('a provider nobody configured', () => {
  test('is named rather than hidden, because it is a mistake in the skill', async () => {
    const response = await call('/nobody/v1/x', withToken())

    expect(response.status).toBe(404)
    expect(await response.text()).toContain('nobody')
  })
})

describe('a token', () => {
  test('says which turn is spending and nothing about who', async () => {
    const read = createTokenReader(SECRET, () => clock)

    const claims = (await read(`Bearer ${token}`)) as TurnToken

    expect(Object.keys(claims).sort()).toEqual(['expiresAt', 'threadID', 'turnID'])
  })
})
