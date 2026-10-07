import { expect, test } from 'bun:test'
import { createServer, type Socket } from 'node:net'
import { createClient, type RedisClientType } from 'redis'
import { connectRedisFixture, destroyRedisFixture } from './redis-connection-fixture'

test('silent native Redis handshakes are aborted, joined and closed within the fixture deadline', async () => {
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    socket.on('data', () => {})
  })
  const failures: unknown[] = []
  let peers: { commands: RedisClientType; reader: RedisClientType } | undefined
  let watchdog: ReturnType<typeof setTimeout> | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing silent endpoint')
    peers = {
      commands: createClient({
        url: `redis://127.0.0.1:${address.port}`,
        socket: { reconnectStrategy: false, connectTimeout: 1000 },
      }),
      reader: createClient({
        url: `redis://127.0.0.1:${address.port}`,
        socket: { reconnectStrategy: false, connectTimeout: 1000 },
      }),
    }
    const { commands, reader } = peers
    // Proof-only watchdog prevents a broken fixture from leaking pending IO.
    watchdog = setTimeout(() => {
      destroyRedisFixture(commands, reader)
    }, 500)
    const cause = await connectRedisFixture(commands, reader, 25).catch(
      (failure: unknown) => failure,
    )
    expect(cause).toBeInstanceOf(AggregateError)
    expect(
      cause instanceof AggregateError &&
        cause.errors.some(
          (error: unknown) =>
            error instanceof Error && error.message === 'Owned Redis connection deadline exceeded',
        ),
    ).toBeTrue()
    expect(commands.isOpen).toBeFalse()
    expect(reader.isOpen).toBeFalse()
  } catch (cause) {
    failures.push(cause)
  }
  clearTimeout(watchdog)
  if (peers) failures.push(...destroyRedisFixture(peers.commands, peers.reader))
  for (const socket of sockets) socket.destroy()
  await new Promise<void>((resolve, reject) => {
    if (!server.listening) {
      resolve()
      return
    }
    server.close((cause) => (cause ? reject(cause) : resolve()))
  }).catch((cause: unknown) => {
    failures.push(cause)
  })
  if (failures.length) throw new AggregateError(failures, 'Silent Redis probe failed')
})
