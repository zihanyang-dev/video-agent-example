import { expect, test } from 'bun:test'
import { createWebQueryClient, sessionQuery } from './session'
import { HTTPError } from '../http'

test('a session refusal discards all cached private facts rather than leaving stale Chats readable', async () => {
  const client = createWebQueryClient()
  client.setQueryData(sessionQuery.queryKey, {
    user: {
      userID: 'alice',
      name: 'Alice',
      email: 'alice@example.com',
      image: null,
    },
  })
  client.setQueryData(['user', 'alice', 'threads'], { threads: ['private'] })
  try {
    await client.fetchQuery({
      queryKey: ['user', 'alice', 'unavailable'],
      queryFn: () => {
        throw new HTTPError(401)
      },
    })
  } catch {
    // The failed read is expected; its privacy side effect is the assertion.
  }
  expect(client.getQueryData(sessionQuery.queryKey)?.user).toBeNull()
  expect(client.getQueryData(['user', 'alice', 'threads'])).toBeUndefined()
  client.clear()
})

test('a late refusal from the previous account does not revoke the current browser identity', async () => {
  const client = createWebQueryClient()
  client.setQueryData(sessionQuery.queryKey, {
    user: { userID: 'bob', name: 'Bob', email: 'bob@example.com', image: null },
  })
  try {
    await client.fetchQuery({
      queryKey: ['user', 'alice', 'late'],
      queryFn: () => {
        throw new HTTPError(401)
      },
    })
  } catch {
    // The old read failed; the current account must remain usable.
  }
  expect(client.getQueryData(sessionQuery.queryKey)?.user?.userID).toBe('bob')
  client.clear()
})
