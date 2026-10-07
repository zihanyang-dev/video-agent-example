import type { RedisClientType } from 'redis'

export function destroyRedisFixture(commands: RedisClientType, reader: RedisClientType) {
  const failures: unknown[] = []
  for (const client of [reader, commands]) {
    if (!client.isOpen) continue
    try {
      client.destroy()
    } catch (cause) {
      failures.push(cause)
    }
  }
  return failures
}

/** A deadline aborts native pending handshakes; final teardown follows settlement. */
export async function connectRedisFixture(
  commands: RedisClientType,
  reader: RedisClientType,
  timeoutMs = 1000,
) {
  const failures: unknown[] = []
  commands.on('error', (cause) => failures.push(cause))
  reader.on('error', (cause) => failures.push(cause))
  const deadline = setTimeout(() => {
    failures.push(new Error('Owned Redis connection deadline exceeded'))
    failures.push(...destroyRedisFixture(commands, reader))
  }, timeoutMs)
  const settled = await Promise.allSettled([commands.connect(), reader.connect()])
  clearTimeout(deadline)
  for (const result of settled) if (result.status === 'rejected') failures.push(result.reason)
  if (failures.length) {
    failures.push(...destroyRedisFixture(commands, reader))
    throw new AggregateError(failures, 'Owned Redis connections failed')
  }
}
