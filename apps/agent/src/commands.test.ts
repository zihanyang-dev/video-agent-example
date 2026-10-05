import { afterAll, expect, test } from 'bun:test'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import { createClient } from 'redis'
import type { DB } from '@vid/database/types'
import { acceptCommandMessages } from './commands'

// Poison must fail before any database or Redis command. These real lazy clients
// have no service behind them; a wrong branch cannot succeed through a mock.
const db = new Kysely<DB>({
  dialect: new PostgresDialect({
    pool: new Pool({
      connectionString: 'postgres://unused:unused@127.0.0.1:1/unused',
      connectionTimeoutMillis: 100,
    }),
  }),
})
const redis = createClient({
  url: 'redis://127.0.0.1:1',
  socket: { reconnectStrategy: false },
})
afterAll(async () => {
  if (redis.isOpen) redis.destroy()
  await db.destroy()
})

test('malformed command failures do not expose private wire content', async () => {
  const failure = await acceptCommandMessages(db, redis, [
    {
      id: '1-0',
      message: { command: 'private_tool_credentials_are_not_json' },
    },
  ]).catch((cause: unknown) => cause)
  expect(failure).toBeInstanceOf(Error)
  expect(failure instanceof Error && failure.message).toBe(
    'Invalid pending command payload',
  )
})

test('deleted and missing command bodies fail before either durable acceptance or ACK', async () => {
  for (const message of [
    null,
    { id: '1-0', message: { wrongField: 'body' } },
  ]) {
    const failure = await acceptCommandMessages(db, redis, [message]).catch(
      (cause: unknown) => cause,
    )
    expect(failure).toBeInstanceOf(Error)
    expect(failure instanceof Error && failure.message).toMatch(
      /pending command payload/,
    )
  }
})
