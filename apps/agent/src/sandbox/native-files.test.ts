import { expect, test } from 'bun:test'
import { openE2BSandbox } from './e2b'
import { CapabilityRejectedError } from '../contract'

function fixture() {
  const paths: string[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      paths.push(url.pathname)
      if (url.pathname === '/v2/sandboxes')
        return Response.json({
          sandboxID: 'owned-files',
          envdVersion: '0.6.2',
          envdAccessToken: 'fixture',
        })
      if (url.pathname === '/files') {
        if (request.method === 'POST')
          return Response.json([{ path: '/owned', name: 'owned', type: 'file' }])
        if (url.searchParams.get('path') === '/missing')
          return Response.json({ message: 'missing' }, { status: 404 })
        return new Response('native HTTP file bytes')
      }
      if (url.pathname.endsWith('/pause')) return new Response(null, { status: 204 })
      return new Response('unexpected route', { status: 500 })
    },
  })
  const endpoint = `http://127.0.0.1:${server.port}`
  return {
    paths,
    stop: () => server.stop(true),
    options: {
      apiURL: endpoint,
      sandboxURL: endpoint,
      apiKey: 'owned-fixture',
      template: 'fixture',
      timeoutMs: 120000,
      assignment: { runID: 'owned', threadID: 'owned', fence: 1 },
    },
  }
}

for (const scenario of ['success', 'absence', 'quota']) {
  test(`native readonly file ${scenario} remains known and closes properly`, async () => {
    const native = fixture()
    try {
      const signal = new AbortController().signal
      const session = await openE2BSandbox(native.options, signal)
      const outcome = await session
        .readBytes(
          scenario === 'absence' ? '/missing' : '/file',
          signal,
          scenario === 'quota' ? 1 : 100,
        )
        .catch((error: unknown) => error)
      if (scenario === 'success') expect(outcome).toEqual(Buffer.from('native HTTP file bytes'))
      else expect(outcome).toBeInstanceOf(Error)
      expect(await session.readBytes('/file', signal, 100)).toEqual(
        Buffer.from('native HTTP file bytes'),
      )
      await session.close()
      expect(native.paths.filter((path) => path === '/files')).toHaveLength(2)
      expect(native.paths.filter((path) => path.endsWith('/pause'))).toHaveLength(1)
    } finally {
      await native.stop()
    }
  })
}

test('local write admission rejects without IO or poisoning the assigned environment', async () => {
  const native = fixture()
  try {
    const signal = AbortSignal.timeout(5000)
    const session = await openE2BSandbox(native.options, signal)
    for (const path of ['', '\0', 'x'.repeat(4097)]) {
      expect(
        await session.write({ path, content: 'no IO', signal }).catch((error: unknown) => error),
      ).toBeInstanceOf(CapabilityRejectedError)
    }
    for (let i = 0; i < 32; i++) await session.write({ path: '/owned', content: 'ok', signal })
    expect(
      await session
        .writeBytes('/owned', new Uint8Array([1]), signal)
        .catch((error: unknown) => error),
    ).toBeInstanceOf(CapabilityRejectedError)
    expect(native.paths.filter((path) => path === '/files')).toHaveLength(32)
    expect(await session.read({ path: '/owned', signal })).toBe('native HTTP file bytes')
    await session.close()
  } finally {
    await native.stop()
  }
})
