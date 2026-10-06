import { expect, test } from 'bun:test'
import { openE2BSandbox } from './e2b'

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
        if (url.searchParams.get('path') === '/missing')
          return Response.json({ message: 'missing' }, { status: 404 })
        return new Response('native HTTP file bytes')
      }
      if (url.pathname.endsWith('/pause'))
        return new Response(null, { status: 204 })
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
      lease: {
        runID: 'owned',
        threadID: 'owned',
        commandID: 'owned',
        messageID: 'owned',
        text: 'fixture',
        history: [],
        fence: 1,
        ownerID: 'owned',
      },
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
      if (scenario === 'success')
        expect(outcome).toEqual(Buffer.from('native HTTP file bytes'))
      else expect(outcome).toBeInstanceOf(Error)
      expect(await session.readBytes('/file', signal, 100)).toEqual(
        Buffer.from('native HTTP file bytes'),
      )
      await session.close()
      expect(native.paths.filter((path) => path === '/files')).toHaveLength(2)
      expect(
        native.paths.filter((path) => path.endsWith('/pause')),
      ).toHaveLength(1)
    } finally {
      await native.stop()
    }
  })
}
