import { ErrorReply, type RedisClientType } from 'redis'

type ReadOptions = Readonly<{ count: number; blockMs: number }>
type ReclaimOptions = Readonly<{
  minIdleMs: number
  count: number
  startID: string
}>

/**
 * A consumer-group subscription, not a producer or a business acceptance policy.
 * The caller owns both connected clients and their error listeners. Keep the reader
 * exclusive to reads; command traffic must not queue behind a blocking read.
 * Stop issuing reads and settle them before closing; destroy rejects pending work.
 * BLOCK limits Redis's wait, not the client's total reconnect/queue duration.
 * Producers use the official client's xAdd directly; no stream trimming is implicit.
 */
export function createRedisConsumer({
  commands,
  blockingReader,
  stream,
  group,
  consumer,
}: Readonly<{
  commands: RedisClientType
  blockingReader: RedisClientType
  stream: string
  group: string
  consumer: string
}>) {
  if (commands === blockingReader)
    throw new Error('Commands and blocking reader must be distinct clients')

  return {
    initialize: async (): Promise<void> => {
      await initializeGroup(commands, { stream, group })
    },
    // '>' delivers new entries only. The pending backlog belongs to reclaim.
    readNew: async ({ count, blockMs }: ReadOptions) => {
      requireInteger(count, 'count', 1)
      requireInteger(blockMs, 'blockMs', 1)
      const reply = await blockingReader.xReadGroup(
        group,
        consumer,
        { key: stream, id: '>' },
        { COUNT: count, BLOCK: blockMs },
      )
      return reply?.[0]?.messages ?? []
    },
    // Advance nextId even on an empty page; 0-0 ends this scan, not future recovery.
    // Preserve deletedMessages: missing transport bodies must not look like an idle queue.
    // Reclaim may overlap a live worker; the owner still fences/deduplicates acceptance.
    reclaim: async ({ minIdleMs, count, startID }: ReclaimOptions) => {
      requireInteger(minIdleMs, 'minIdleMs', 0)
      requireInteger(count, 'count', 1)
      return await commands.xAutoClaim(
        stream,
        group,
        consumer,
        minIdleMs,
        startID,
        { COUNT: count },
      )
    },
    // Only after durable acceptance. ACK removes pending state, not the stream entry.
    acknowledge: async (id: string): Promise<number> =>
      await commands.xAck(stream, group, id),
  }
}

async function initializeGroup(
  commands: RedisClientType,
  subscription: Readonly<{ stream: string; group: string }>,
): Promise<void> {
  // Start at the beginning so publication before startup is not lost.
  try {
    await commands.xGroupCreate(
      subscription.stream,
      subscription.group,
      '0-0',
      { MKSTREAM: true },
    )
  } catch (error) {
    // An existing group keeps its cursor; unrelated Redis failures must remain visible.
    if (!(
      error instanceof ErrorReply && error.message.startsWith('BUSYGROUP ')
    ))
      throw error
  }
}

function requireInteger(bound: number, name: string, minimum: number): void {
  // number does not exclude fractions; BLOCK 0 would silently mean an indefinite wait.
  if (!Number.isSafeInteger(bound) || bound < minimum)
    throw new RangeError(`${name} must be a safe integer >= ${minimum}`)
}
