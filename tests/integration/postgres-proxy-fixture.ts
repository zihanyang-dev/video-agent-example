import { createConnection, createServer, type Socket } from 'node:net'

/** Owned test-only transport: forward requests, optionally discard backend replies. */
export async function postgresProxy(databaseURL: string) {
  const target = new URL(databaseURL)
  const backendAddress = {
    host: target.hostname,
    port: Number(target.port || 5432),
  }
  const sockets = new Set<Socket>()
  let blackhole = false
  let connections = 0
  let closedClients = 0
  let requests = 0
  const server = createServer((client) => {
    connections++
    sockets.add(client)
    const backend = createConnection(backendAddress)
    sockets.add(backend)
    client.pause()
    backend.on('connect', () => client.resume())
    client.on('data', (bytes) => {
      requests++
      backend.write(bytes)
    })
    backend.on('data', (bytes) => {
      if (!blackhole) client.write(bytes)
    })
    client.on('error', () => backend.destroy())
    backend.on('error', () => client.destroy())
    client.on('close', () => {
      closedClients++
      sockets.delete(client)
      backend.destroy()
    })
    backend.on('close', () => {
      sockets.delete(backend)
      client.destroy()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Missing proxy port')
  target.hostname = '127.0.0.1'
  target.port = String(address.port)
  return {
    databaseURL: target.toString(),
    blackhole: () => {
      blackhole = true
    },
    restore: () => {
      blackhole = false
    },
    get connections() {
      return connections
    },
    get closedClients() {
      return closedClients
    },
    get requests() {
      return requests
    },
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    },
  }
}

export async function eventually(condition: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (!condition() && Date.now() < deadline) await Bun.sleep(10)
}
