/**
 * Redis Streams transport with acknowledgment after the consumer accepts a message.
 *
 * Reclaimed entries can repeat after a worker fails, so durable acceptance and deduplication
 * belong to the consumer. This package parses the JSON envelope without knowing command or
 * event schemas, and a refused delivery stays pending for a later attempt.
 */
import { RedisClient } from 'bun'

export type Mailbox = {
  publish: (body: unknown) => Promise<void>
  /** ACK only after durable acceptance. False defers delivery; throwing stops the consumer. */
  consume: (accept: (body: unknown) => Promise<boolean>, signal: AbortSignal) => Promise<void>
  close: () => void
}

export const createRedisMailbox = (address: {
  url: string
  stream: string
  group: string
  consumer: string
}): Mailbox => {
  // XREADGROUP blocks its connection; publication must use a separate client.
  const writer = new RedisClient(address.url)
  const reader = new RedisClient(address.url)

  return {
    publish: async (body) => {
      await writer.send('XADD', [address.stream, '*', 'body', JSON.stringify(body)])
    },

    consume: async (accept, signal) => {
      await ensureGroup(reader, address)

      // Advance the pending scan so deferred entries cannot starve later abandoned deliveries.
      let cursor = '0-0'
      while (!signal.aborted) cursor = await receive(reader, { ...address, cursor }, accept)
    },

    close: () => {
      writer.close()
      reader.close()
    },
  }
}

type ConsumerAddress = {
  stream: string
  group: string
  consumer: string
}

// Bun exposes raw Redis command responses; these tuples follow the Streams wire format.
type StreamEntry = [entryID: string, fields: string[]]
type PendingScan = [nextCursor: string, entries: StreamEntry[], deletedEntryIDs: string[]]

// Start at zero: commands may exist before the first worker creates its consumer group.
const ensureGroup = async (client: RedisClient, address: ConsumerAddress): Promise<void> => {
  try {
    await client.send('XGROUP', ['CREATE', address.stream, address.group, '0', 'MKSTREAM'])
  } catch (error) {
    // Another consumer may have created the group; all other Redis failures remain fatal.
    if (!String(error).includes('BUSYGROUP')) throw error
  }
}

const receive = async (
  client: RedisClient,
  address: ConsumerAddress & { cursor: string },
  accept: (body: unknown) => Promise<boolean>,
): Promise<string> => {
  const reclaimed = (await client.send('XAUTOCLAIM', [
    address.stream,
    address.group,
    address.consumer,
    '1000',
    address.cursor,
    'COUNT',
    '50',
  ])) as PendingScan
  const [nextCursor, pendingEntries] = reclaimed
  for (const entry of pendingEntries) await deliver(client, address, entry, accept)

  const reply = (await client.send('XREADGROUP', [
    'GROUP',
    address.group,
    address.consumer,
    'BLOCK',
    '200',
    'COUNT',
    '50',
    'STREAMS',
    address.stream,
    '>',
  ])) as Record<string, StreamEntry[]> | null
  for (const entry of reply?.[address.stream] ?? []) await deliver(client, address, entry, accept)

  return nextCursor
}

const deliver = async (
  client: RedisClient,
  address: ConsumerAddress,
  entry: StreamEntry,
  accept: (body: unknown) => Promise<boolean>,
): Promise<void> => {
  const [entryID, fields] = entry
  const bodyPosition = fields.indexOf('body')
  if (bodyPosition < 0) throw new Error(`missing body in ${address.stream}/${entryID}`)

  const body: unknown = JSON.parse(fields[bodyPosition + 1]!)
  if (!(await accept(body))) return

  await client.send('XACK', [address.stream, address.group, entryID])
}
