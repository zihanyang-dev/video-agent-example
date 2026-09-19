/**
 * The gateway is what stands between a command the model wrote and the money it can spend.
 *
 * Every case here is a way that could fail: the real credential reaching the sandbox, a
 * turn's token reaching a provider, a forged or expired token buying anything, or a refused
 * call being counted as spending.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createTokenReader, mintTurnToken, type TurnToken } from '@vid/turn-token'
import { createForwarder } from './forward'

const SECRET = 'a'.repeat(48)
const REAL_KEY = 'the-real-provider-key'

let clock = Date.now()
const spends: string[] = []

/** Reports exactly what reached it, so the test can see what the gateway sent. */
const provider = Bun.serve({
  port: 0,
  fetch: async (request) => {
    const url = new URL(request.url)

    // Real providers compress. A gateway that forwards the encoding header along with a
    // body `fetch` already decompressed hands the caller a ZlibError -- which is how this
    // was found, on the first call that left the machine.
    if (url.pathname === '/compressed') {
      return new Response(Bun.gzipSync(new TextEncoder().encode('{"ok":true}')), {
        headers: { 'content-encoding': 'gzip', 'content-type': 'application/json' },
      })
    }

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
      // A provider this deployment has an opinion about.
      pinned: {
        baseUrl: `http://localhost:${provider.port}`,
        header: 'x-provider-key',
        key: REAL_KEY,
        models: ['doubao-seedance-2-0-260128'],
        results: ['results.example.com'],
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

describe('a compressed answer', () => {
  test('is readable by the caller', async () => {
    const response = await call('/seedance/compressed', withToken())

    expect(await response.json()).toEqual({ ok: true })
  })

  test('does not claim an encoding it no longer has', async () => {
    const response = await call('/seedance/compressed', withToken())

    expect(response.headers.get('content-encoding')).toBeNull()
  })
})

describe('a model this deployment does not pay for', () => {
  test('is refused, because a skill cannot stop the agent asking for it directly', async () => {
    const response = await call('/pinned/v1/generations', {
      ...withToken(),
      method: 'POST',
      body: JSON.stringify({ model: 'doubao-seedance-1-0-pro-fast-251015', content: [] }),
    })

    expect(response.status).toBe(403)
    expect(await response.text()).toContain('doubao-seedance-1-0-pro-fast-251015')
  })

  test('is not recorded as spending, because nothing was spent', async () => {
    const before = spends.length

    await call('/pinned/v1/generations', {
      ...withToken(),
      method: 'POST',
      body: JSON.stringify({ model: 'something-else' }),
    })

    expect(spends).toHaveLength(before)
  })

  test('does not stop the one it does pay for', async () => {
    const response = await call('/pinned/v1/generations', {
      ...withToken(),
      method: 'POST',
      body: JSON.stringify({ model: 'doubao-seedance-2-0-260128', content: [] }),
    })

    expect(response.status).toBe(200)
  })

  test('does not stop polling a task, which names no model and buys nothing', async () => {
    const response = await call('/pinned/v1/tasks/cgt-1', withToken())

    expect(response.status).toBe(200)
  })

  test('leaves a provider with no opinion alone', async () => {
    const response = await call('/seedance/v1/generations', {
      ...withToken(),
      method: 'POST',
      body: JSON.stringify({ model: 'anything-at-all' }),
    })

    expect(response.status).toBe(200)
  })
})

describe('fetching a finished result, which the sandbox cannot do itself', () => {
  const fetchResult = (url: string): Promise<Response> =>
    call(`/pinned/_result?url=${encodeURIComponent(url)}`, withToken())

  test('is refused for a host this deployment did not name', async () => {
    const response = await fetchResult('https://somewhere-else.example.com/clip.mp4')

    expect(response.status).toBe(403)
  })

  test('is refused for anything that is not https, so this cannot reach inside the network', async () => {
    expect((await fetchResult('http://results.example.com/clip.mp4')).status).toBe(403)
    expect((await fetchResult('file:///etc/passwd')).status).toBe(403)
    expect((await fetchResult('http://169.254.169.254/latest/meta-data/')).status).toBe(403)
  })

  test('is refused for a provider that names no result hosts at all', async () => {
    const response = await call(
      `/seedance/_result?url=${encodeURIComponent('https://results.example.com/clip.mp4')}`,
      withToken(),
    )

    expect(response.status).toBe(403)
  })

  test('still needs a turn token', async () => {
    const response = await call(
      `/pinned/_result?url=${encodeURIComponent('https://results.example.com/clip.mp4')}`,
      {},
    )

    expect(response.status).toBe(401)
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
