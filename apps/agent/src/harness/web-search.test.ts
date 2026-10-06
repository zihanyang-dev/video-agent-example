import { expect, test } from 'bun:test'
import { webSearchTool, type WebSearchConfig } from './web-search'

type SearchTransport = NonNullable<WebSearchConfig['transport']>

const source = {
  title: '<b>Public</b>',
  url: 'https://example.org/story',
  content: '<p>Evidence</p>',
}
function tool(
  transport: SearchTransport,
  owner = new AbortController().signal,
) {
  return webSearchTool({ authMode: 'keyless', transport }, owner)
}
async function run(
  native: ReturnType<typeof tool>,
  query = 'public facts',
  signal?: AbortSignal,
) {
  const result = await native.execute(
    'fixture',
    { query },
    signal,
    undefined,
    {} as Parameters<typeof native.execute>[4],
  )
  return JSON.parse(
    result.content[0]!.type === 'text' ? result.content[0]!.text : '',
  ) as Record<string, unknown>
}

test('fixed provider request and bounded sanitized citation evidence', async () => {
  let dispatches = 0
  const native = tool((async (url, init) => {
    dispatches++
    expect(url).toBe('https://api.tavily.com/search')
    expect(init?.redirect).toBe('error')
    expect(new Headers(init?.headers).get('X-Tavily-Access-Mode')).toBe(
      'keyless',
    )
    expect(new Headers(init?.headers).has('authorization')).toBe(false)
    expect(JSON.parse(init?.body as string)).toEqual({
      query: 'public facts',
      search_depth: 'basic',
      auto_parameters: false,
      max_results: 5,
      chunks_per_source: 3,
      include_answer: false,
      include_raw_content: false,
      include_images: false,
      topic: 'general',
    })
    return Response.json({
      results: [source],
      answer: 'PRIVATE PROVIDER ANSWER',
    })
  }) as SearchTransport)
  expect(await run(native)).toMatchObject({
    status: 'ok',
    results: [{ title: 'Public', url: source.url, snippet: 'Evidence' }],
  })
  expect(dispatches).toBe(1)
})

test('parallel calls reserve three dispatches before await; no retry/refund', async () => {
  let dispatches = 0
  const native = tool((async () => {
    dispatches++
    await Bun.sleep(10)
    throw new Error('PRIVATE KEY')
  }) as SearchTransport)
  const results = await Promise.all(
    Array.from({ length: 6 }, () => run(native)),
  )
  expect(dispatches).toBe(3)
  expect(JSON.stringify(results)).not.toContain('PRIVATE KEY')
  expect(
    results.filter(
      (result) => result.error === 'Search limit reached for this turn.',
    ),
  ).toHaveLength(3)
})

test('empty is explicit, bad shape and oversized body are safe errors', async () => {
  expect(
    await run(
      tool((async () => Response.json({ results: [] })) as SearchTransport),
    ),
  ).toMatchObject({ status: 'empty', results: [] })
  for (const response of [
    Response.json({ results: 'PRIVATE' }),
    new Response('x'.repeat(262145)),
  ]) {
    expect(
      await run(tool((async () => response) as SearchTransport)),
    ).toMatchObject({ status: 'unavailable', error: 'Web search unavailable.' })
  }
})

test('invalid queries never dispatch; pre-aborted owner wins over SDK signal', async () => {
  let dispatches = 0
  const transport = (async () => {
    dispatches++
    return Response.json({ results: [] })
  }) as SearchTransport
  for (const query of ['', ' ', 'x'.repeat(401), '😀'.repeat(401)])
    expect(await run(tool(transport), query)).toMatchObject({
      status: 'unavailable',
    })
  const owner = new AbortController()
  const reason = new Error('lease lost')
  owner.abort(reason)
  expect(
    run(tool(transport, owner.signal), 'public', new AbortController().signal),
  ).rejects.toBe(reason)
  expect(dispatches).toBe(0)
})

test('unsafe citation URLs are omitted and model JSON remains within 16 KiB', async () => {
  const results = [
    source,
    ...[
      'http://127.0.0.1/x',
      'http://[::1]/',
      'https://user:pass@example.org/',
      'javascript:alert(1)',
      'https://example.org/?token=secret',
      'http://private.internal/',
    ].map((url) => ({ ...source, url })),
    ...Array.from({ length: 5 }, () => ({
      ...source,
      title: '中'.repeat(500),
      content: '中'.repeat(3000),
    })),
  ]
  const result = await run(
    tool((async () => Response.json({ results })) as SearchTransport),
  )
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(16384)
  expect(JSON.stringify(result)).not.toContain('secret')
  expect(result.truncated).toBe(true)
  expect((result.results as unknown[]).length).toBeLessThanOrEqual(5)
})

test('hard auth/quota refusal closes this turn spending gate', async () => {
  let dispatches = 0
  const native = tool((async () => {
    dispatches++
    return new Response('PRIVATE', { status: 429 })
  }) as SearchTransport)
  await run(native)
  await run(native)
  expect(dispatches).toBe(1)
})

test('active abort preserves reason and awaits body cancellation cleanup', async () => {
  const owner = new AbortController()
  let release!: () => void
  let started!: () => void
  const start = new Promise<void>((resolve) => {
    started = resolve
  })
  const cleanup = new Promise<void>((resolve) => {
    release = resolve
  })
  const native = tool(
    (async () =>
      new Response(
        new ReadableStream({
          start() {
            started()
          },
          async cancel() {
            await cleanup
          },
        }),
      )) as SearchTransport,
    owner.signal,
  )
  const request = run(native)
  let settled = false
  const outcome = request.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    },
  )
  await start
  const reason = new Error('owner cancellation')
  owner.abort(reason)
  await Bun.sleep(20)
  expect(settled).toBe(false)
  release()
  await outcome
  expect(request).rejects.toBe(reason)
})

test('deadline includes a stalled body (real ten second budget)', async () => {
  let canceled = false
  const native = tool(
    (async () =>
      new Response(
        new ReadableStream({
          cancel() {
            canceled = true
          },
        }),
      )) as SearchTransport,
  )
  expect(await run(native)).toMatchObject({
    status: 'unavailable',
    error: 'Web search timed out.',
  })
  expect(canceled).toBe(true)
}, 12000)

test('encoded HTML and private host spellings never become citation evidence', async () => {
  const result = await run(
    tool((async () =>
      Response.json({
        results: [
          {
            ...source,
            title: '&lt;b&gt;Title&lt;/b&gt;',
            content: '&#60;script&#62;PRIVATE&#60;/script&#62;Public',
          },
          { ...source, url: 'http://localhost./' },
          { ...source, url: 'http://private.internal./' },
          { ...source, url: 'http://2130706433/' },
          { ...source, url: 'http://[::ffff:127.0.0.1]/' },
        ],
      })) as SearchTransport),
  )
  expect(result.results).toEqual([
    { title: 'Title', url: source.url, snippet: 'Public' },
  ])
  expect(JSON.stringify(result)).not.toContain('PRIVATE')
})

test('key mode uses only bound worker key and omits credentials from tool output', async () => {
  const native = webSearchTool(
    {
      authMode: 'key',
      apiKey: 'fixture-secret',
      transport: (async (_url, init) => {
        expect(new Headers(init?.headers).get('Authorization')).toBe(
          'Bearer fixture-secret',
        )
        expect(new Headers(init?.headers).has('X-Tavily-Access-Mode')).toBe(
          false,
        )
        return Response.json({ results: [source], api_key: 'fixture-secret' })
      }) as SearchTransport,
    },
    new AbortController().signal,
  )
  expect(JSON.stringify(await run(native))).not.toContain('fixture-secret')
})

test('byte overflow cancels streaming body and waits for cancellation to settle', async () => {
  let release!: () => void
  let canceled!: () => void
  const cleanup = new Promise<void>((resolve) => {
    release = resolve
  })
  const cancellation = new Promise<void>((resolve) => {
    canceled = resolve
  })
  const native = tool(
    (async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(262145))
          },
          async cancel() {
            canceled()
            await cleanup
          },
        }),
      )) as SearchTransport,
  )
  let settled = false
  const request = run(native)
  const outcome = request.then(() => {
    settled = true
  })
  await cancellation
  expect(settled).toBe(false)
  release()
  await outcome
  expect(await request).toMatchObject({ status: 'unavailable' })
})

test('SDK cancellation preserves the SDK reason and blocks later dispatch', async () => {
  const sdk = new AbortController()
  const reason = new Error('SDK aborted')
  let dispatched = 0
  const native = tool((async () => {
    dispatched++
    return Response.json({ results: [] })
  }) as SearchTransport)
  sdk.abort(reason)
  expect(run(native, 'public', sdk.signal)).rejects.toBe(reason)
  expect(dispatched).toBe(0)
})

test('real loopback HTTP rejects redirects and caps decompressed provider bytes', async () => {
  let traps = 0
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname
      if (path === '/redirect')
        return new Response(null, {
          status: 302,
          headers: { location: '/trap' },
        })
      if (path === '/trap') {
        traps++
        return Response.json({ results: [] })
      }
      return new Response(
        Bun.gzipSync(
          new TextEncoder().encode(
            JSON.stringify({ results: [], padding: 'x'.repeat(262144) }),
          ),
        ),
        {
          headers: {
            'Content-Encoding': 'gzip',
            'Content-Type': 'application/json',
          },
        },
      )
    },
  })
  try {
    for (const path of ['/redirect', '/compressed']) {
      const native = tool(((url, init) => {
        expect(url).toBe('https://api.tavily.com/search')
        return fetch(`http://127.0.0.1:${server.port}${path}`, init)
      }) as SearchTransport)
      expect(await run(native)).toMatchObject({
        status: 'unavailable',
        error: 'Web search unavailable.',
      })
    }
    expect(traps).toBe(0)
  } finally {
    await server.stop(true)
  }
})

test('owner abort during refused-response cleanup preserves reason after settlement', async () => {
  const owner = new AbortController()
  let release!: () => void
  let canceling!: () => void
  const cleanup = new Promise<void>((resolve) => {
    release = resolve
  })
  const canceled = new Promise<void>((resolve) => {
    canceling = resolve
  })
  const native = tool(
    (async () =>
      new Response(
        new ReadableStream({
          async cancel() {
            canceling()
            await cleanup
          },
        }),
        { status: 500 },
      )) as SearchTransport,
    owner.signal,
  )
  const request = run(native)
  const outcome = request.catch(() => {})
  await canceled
  const reason = new Error('shutdown during cleanup')
  owner.abort(reason)
  release()
  await outcome
  expect(request).rejects.toBe(reason)
})

test('malformed result fields are unavailable rather than a false no-results claim', async () => {
  const native = tool((async () =>
    Response.json({
      results: [{ ...source, content: 42 }],
    })) as SearchTransport)
  expect(await run(native)).toMatchObject({
    status: 'unavailable',
    error: 'Web search unavailable.',
  })
})

test('parallel ordinary refusal cannot reopen a hard-refusal spending gate', async () => {
  let dispatches = 0
  let release!: () => void
  const ordinary = new Promise<void>((resolve) => {
    release = resolve
  })
  const native = tool(async () => {
    dispatches++
    if (dispatches === 1) return new Response(null, { status: 429 })
    await ordinary
    return new Response(null, { status: 500 })
  })
  const hard = run(native)
  const pending = run(native)
  await hard
  release()
  await pending
  await run(native)
  expect(dispatches).toBe(2)
})

test('source capture projects only normalized actual results and drops unsafe entries before the five-result limit', async () => {
  const found: unknown[] = []
  const native = webSearchTool(
    {
      authMode: 'keyless',
      transport: async () =>
        Response.json({
          results: [
            { ...source, url: 'https://8.8.8.8/' },
            ...Array.from({ length: 8 }, (_, index) => ({
              ...source,
              url: `https://example.org/${index}`,
            })),
          ],
          query: 'PRIVATE QUERY',
          key: 'PRIVATE KEY',
        }),
    },
    new AbortController().signal,
    (sources) => found.push(...sources),
  )
  await run(native)
  expect(found).toEqual(
    Array.from({ length: 5 }, (_, index) => ({
      title: 'Public',
      url: `https://example.org/${index}`,
    })),
  )
  expect(JSON.stringify(found)).not.toContain('PRIVATE')
  expect(JSON.stringify(found)).not.toContain('snippet')
})

test('normalized citation URL length is bounded after native percent encoding', async () => {
  const found: unknown[] = []
  const native = webSearchTool(
    {
      authMode: 'keyless',
      transport: async () =>
        Response.json({
          results: [
            { ...source, url: `https://example.org/${'中'.repeat(1000)}` },
            { ...source, url: 'https://example.org/é' },
          ],
        }),
    },
    new AbortController().signal,
    (sources) => found.push(...sources),
  )
  await run(native)
  expect(found).toEqual([
    { title: 'Public', url: 'https://example.org/%C3%A9' },
  ])
})
