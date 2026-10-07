import { expect, test } from 'bun:test'
import { createServer } from 'node:net'
import { postgresProxy } from './postgres-proxy-fixture'

test('occupied proxy bind rejects promptly and owns any unexpectedly opened listener', async () => {
  const occupied = createServer()
  let proxy: Awaited<ReturnType<typeof postgresProxy>> | undefined
  const failures: unknown[] = []
  try {
    await new Promise<void>((resolve, reject) => {
      occupied.once('error', reject)
      occupied.listen(0, '127.0.0.1', resolve)
    })
    const address = occupied.address()
    if (!address || typeof address === 'string') throw new Error('Missing occupied port')
    const cause = await postgresProxy('postgres://unused@127.0.0.1:5432/unused', address.port).then(
      (opened) => {
        proxy = opened
        return undefined
      },
      (failure: unknown) => failure,
    )
    expect(cause).toBeInstanceOf(Error)
    expect(cause).toMatchObject({ code: 'EADDRINUSE' })
  } catch (cause) {
    failures.push(cause)
  }
  const cleanup = await Promise.allSettled([
    Promise.resolve().then(() => proxy?.close()),
    new Promise<void>((resolve, reject) => {
      if (!occupied.listening) {
        resolve()
        return
      }
      occupied.close((cause) => (cause ? reject(cause) : resolve()))
    }),
  ])
  for (const result of cleanup) if (result.status === 'rejected') failures.push(result.reason)
  if (failures.length) throw new AggregateError(failures, 'Proxy bind fixture failed')
})
