import { expect, test } from 'bun:test'
import { createServer } from 'node:http'
import { deploymentRequest } from './deployment-http-fixture'

const scenarios = ['null', 'headers', 'body', 'nonready', 'private', 'malformed'] as const
async function checkOutcome(
  scenario: (typeof scenarios)[number],
  outcome: Awaited<ReturnType<typeof deploymentRequest>>,
  connectionClosed: () => boolean,
) {
  if (scenario === 'headers' || scenario === 'body') {
    expect(outcome.failures).toHaveLength(1)
    expect(outcome.failures[0]).toMatchObject({
      message: 'Deployment HTTP deadline exceeded',
    })
  } else if (scenario === 'malformed') expect(outcome.failures[0]).toBeInstanceOf(SyntaxError)
  else expect(outcome.failures).toEqual([])
  if (scenario === 'null') expect(outcome.body).toBeNull()
  if (scenario === 'nonready' || scenario === 'private') {
    const deadline = performance.now() + 100
    while (!connectionClosed() && performance.now() < deadline) await Bun.sleep(2)
    expect(connectionClosed()).toBeTrue()
  }
}

for (const scenario of scenarios) {
  test(`deployment request owns ${scenario} through native body settlement`, async () => {
    let connectionClosed = false
    const server = createServer((_request, response) => {
      if (scenario === 'headers') return
      response.writeHead(scenario === 'nonready' ? 503 : scenario === 'private' ? 401 : 200)
      if (scenario === 'null') response.end('null')
      else if (scenario === 'malformed') response.end('{')
      else response.write('n')
    })
    server.on('connection', (socket) =>
      socket.on('close', () => {
        connectionClosed = true
      }),
    )
    const failures: unknown[] = []
    let watchdog: ReturnType<typeof setTimeout> | undefined
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Missing owned HTTP port')
      watchdog = setTimeout(() => {
        server.closeAllConnections()
      }, 600)
      const started = performance.now()
      const outcome = await deploymentRequest(
        `http://127.0.0.1:${address.port}`,
        started + 1000,
        scenario !== 'private',
        50,
      )
      expect(performance.now() - started).toBeLessThan(400)
      await checkOutcome(scenario, outcome, () => connectionClosed)
    } catch (cause) {
      failures.push(cause)
    }
    clearTimeout(watchdog)
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
      if (!server.listening) {
        resolve()
        return
      }
      server.close((cause) => (cause ? reject(cause) : resolve()))
    }).catch((cause: unknown) => {
      failures.push(cause)
    })
    if (failures.length) throw new AggregateError(failures, 'Deployment HTTP probe failed')
  })
}
