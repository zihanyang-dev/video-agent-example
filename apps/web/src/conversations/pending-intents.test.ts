import { expect, test } from 'bun:test'
import { pendingIntents } from './pending-intents'

function memoryStorage(): Storage {
  const entries = new Map<string, string>()
  return {
    get length() {
      return entries.size
    },
    clear: () => entries.clear(),
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value)
    },
    removeItem: (key) => {
      entries.delete(key)
    },
    key: (index) => [...entries.keys()][index] ?? null,
  }
}

test('unknown message acceptance survives a new owner instance with identical text and assets', () => {
  const storage = memoryStorage()
  const first = pendingIntents('alice', storage)
  const frozen = first.message('chat', {
    text: 'Original',
    assetIDs: ['11111111-1111-4111-8111-111111111111'],
  })
  const reload = pendingIntents('alice', storage)
  expect(reload.message('chat', { text: 'Edited', assetIDs: [] })).toEqual(
    frozen,
  )
  expect(reload.readMessage('chat')).toEqual(frozen)
  expect(pendingIntents('bob', storage).readMessage('chat')).toBeUndefined()
  reload.acceptMessage('chat')
  expect(
    reload.message('chat', { text: 'Edited', assetIDs: [] }).messageID,
  ).not.toBe(frozen.messageID)
})

test('corrupt retained requests fail closed with recovery guidance and no private parser diagnostics', async () => {
  const storage = memoryStorage()
  const prefix = 'frame:intent:alice:'
  const requests = [
    {
      key: 'creation',
      read: () => pendingIntents('alice', storage).readCreation(),
    },
    {
      key: 'message:chat',
      read: () => pendingIntents('alice', storage).readMessage('chat'),
    },
    {
      key: 'cancel:chat:run',
      read: () =>
        pendingIntents('alice', storage).cancellation({
          threadID: 'chat',
          runID: 'run',
        }),
    },
  ]
  for (const request of requests) {
    for (const body of [
      'private_pending_request_not_json',
      '{"threadID":"private_pending_request_not_uuid"}',
    ]) {
      storage.setItem(prefix + request.key, body)
      const failure = await Promise.resolve()
        .then(() => request.read())
        .catch((cause: unknown) => cause)
      expect(failure).toBeInstanceOf(Error)
      expect(failure instanceof Error && failure.message).toBe(
        'Saved pending request could not be decoded. Check Chat history before clearing browser data.',
      )
      expect(storage.getItem(prefix + request.key)).toBe(body)
    }
  }
})

test('creation and cancellation IDs and bodies survive reload without automatic replay', () => {
  const storage = memoryStorage()
  const first = pendingIntents('alice', storage)
  const creation = first.creation('Original')
  const cancellation = first.cancellation({ threadID: 'chat', runID: 'run' })
  const reload = pendingIntents('alice', storage)
  expect(reload.creation('Edited')).toEqual(creation)
  expect(reload.cancellation({ threadID: 'chat', runID: 'run' })).toEqual(
    cancellation,
  )
  reload.acceptCreation()
  expect(reload.creation('Edited').threadID).not.toBe(creation.threadID)
})
