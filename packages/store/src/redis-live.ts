/**
 * The live stream, on a Redis stream.
 *
 * A Redis stream is the shape this needs, not a coincidence: entries are ordered, each gets
 * an id, and a reader can ask for everything after an id it already has. That last part is
 * the whole reason a stream rather than a pub/sub channel -- a laptop closing mid-turn must
 * not leave a hole in the page (architecture.md §3.1).
 *
 * Entries expire. Nothing here is truth; the durable record is written separately, and a
 * reader arriving after the window has passed reads that instead.
 */
import type { Event } from '@ag-ui/core'
import { EventSchema } from '@ag-ui/core/schemas'
import { RedisClient } from 'bun'
import type { LiveStream, StreamCursor } from './live'

/**
 * How long a turn's fragments stay readable. Long enough to cover a reconnect, short enough
 * that a week of conversations is not sitting in memory.
 *
 * A reader further behind than this is sent the whole conversation again instead -- see
 * `reachable`. That used to be written here as though it happened on its own; it did not,
 * and a reconnect from beyond the window resumed quietly with a hole in the middle of it.
 */
const WINDOW_MS = 30 * 60 * 1000

/** How long one read waits before looping, so an aborted read notices within a second. */
const BLOCK_MS = 1_000

export type RedisLiveStream = LiveStream & { close: () => void }

export const createRedisLiveStream = (url: string): RedisLiveStream => {
  const client = new RedisClient(url)

  const publish = async (threadID: string, event: Event): Promise<void> => {
    await client.send('XADD', [
      keyOf(threadID),
      'MINID',
      '~',
      String(Date.now() - WINDOW_MS),
      '*',
      'event',
      JSON.stringify(event),
    ])
  }

  async function* read(
    cursor: StreamCursor,
    signal: AbortSignal,
  ): AsyncIterable<{ id: string; event: Event }> {
    const key = keyOf(cursor.thread)
    // "0" means everything the stream still holds; a real id means everything after it.
    let position = cursor.after ?? '0'

    while (!signal.aborted) {
      const reply = await client.send('XREAD', [
        'BLOCK',
        String(BLOCK_MS),
        'STREAMS',
        key,
        position,
      ])

      for (const entry of entriesOf(reply, key)) {
        position = entry.id
        yield entry
      }
    }
  }

  /**
   * Abort the readers first. Closing the connection under a blocked read raises from a call
   * nobody is waiting on any more.
   */
  const close = (): void => client.close()

  return { publish, reachable: (cursor) => stillHolds(client, cursor), read, close }
}

const keyOf = (threadID: string): string => `live:${threadID}`

/**
 * Bun's client speaks RESP3, so XREAD answers with a map keyed by stream name rather than
 * the nested arrays the RESP2 protocol documentation shows -- verified against a real
 * server, because guessing this wrong produces an empty stream rather than an error. A
 * block that timed out with nothing new answers `null`.
 *
 * Each entry is still `[id, [field, value, field, value, ...]]`.
 */
const entriesOf = (reply: unknown, key: string): { id: string; event: Event }[] => {
  if (reply === null || typeof reply !== 'object') return []

  const forKey = (reply as Record<string, unknown>)[key]
  if (!Array.isArray(forKey)) return []

  return forKey.flatMap(decode)
}

const safeJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

const decode = (entry: unknown): { id: string; event: Event }[] => {
  if (!Array.isArray(entry)) return []

  const id = String(entry[0])
  const fields = (Array.isArray(entry[1]) ? entry[1] : []).map(String)
  const at = fields.indexOf('event')
  const payload = at === -1 ? undefined : fields[at + 1]
  if (payload === undefined) return []

  // Parsed rather than asserted. This is a message from another process (code-style §4.1):
  // an agent a version behind, or anything else that reached this key, would otherwise be
  // handed to a browser as though we had written it.
  //
  // A bad entry is dropped rather than thrown. One of them must not end a stream everything
  // else is still being read from.
  const parsed = EventSchema.safeParse(safeJson(payload))
  return parsed.success ? [{ id, event: parsed.data as Event }] : []
}

/** The id of the first entry an `XRANGE` answered with, or null when it answered with none. */
const firstIdOf = (reply: unknown): string | null => {
  if (!Array.isArray(reply) || reply.length === 0) return null

  const entry = reply[0]
  if (!Array.isArray(entry) || typeof entry[0] !== 'string') return null
  return entry[0]
}

const millisecondsOf = (id: string): number => Number(id.split('-')[0] ?? 0)

/**
 * False when the stream has already dropped everything the cursor points at.
 *
 * Ids sort by their millisecond, so the comparison is on that rather than on the string:
 * `9-0` is lexically larger than `10-0` and numerically smaller.
 */
const stillHolds = async (client: RedisClient, cursor: StreamCursor): Promise<boolean> => {
  if (cursor.after === null) return true

  const oldest = await client.send('XRANGE', [keyOf(cursor.thread), '-', '+', 'COUNT', '1'])
  const first = firstIdOf(oldest)

  // A reader holding a position into a stream with nothing left in it saw something that has
  // since been trimmed. Unreachable, deliberately: anything we cannot show is still covered
  // gets the conversation again.
  if (first === null) return false

  return millisecondsOf(first) <= millisecondsOf(cursor.after)
}
