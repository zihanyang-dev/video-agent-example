/**
 * The turn queue, on a Redis stream with a consumer group.
 *
 * The same Redis the live stream already needs, so this adds no dependency. A consumer
 * group is what makes it a queue rather than a broadcast: every agent process reads from one
 * group, so each turn goes to exactly one of them, and a turn stays claimed until it is
 * acknowledged.
 *
 * Nothing here retries a turn that failed. An unacknowledged entry stays in the group's
 * pending list, where it is visible and recoverable, and what to do with it is a judgement
 * about money: a turn that died after telling a provider to render has already spent some,
 * and replaying it spends it again (architecture.md §4). A person looks and decides, which
 * is what `unknown` means.
 */
import { RedisClient } from 'bun'
import { TurnRequest, type TurnQueue } from './turn-request'

const STREAM = 'turns'
const GROUP = 'agents'

/** Which stream this membership reads and writes. */
const streamOf = (membership: { stream?: string }): string => membership.stream ?? STREAM

/** How long a read waits before looping, so a draining process notices within a second. */
const BLOCK_MS = 1_000

export type QueueMembership = {
  url: string
  /** Names this process within the group. Two processes must not share one. */
  consumer: string
  /**
   * Told about a turn that failed, which stays claimed.
   *
   * Not optional. A queue that swallowed these would hide the only signal that work is
   * piling up in the pending list.
   */
  onFailed: (turn: TurnRequest, error: unknown) => void
  /**
   * Which stream. Defaults to the one a deployment uses.
   *
   * Configurable because a test suite and a running agent share one Redis, and sharing one
   * queue means they take each other's work: measured, in both directions -- the agent
   * claimed ten turns belonging to a test and failed every one of them on a thread that
   * only existed inside the test, and the test was left waiting for turns that had already
   * been eaten. A name per run costs nothing and ends it.
   */
  stream?: string
  /**
   * How many turns this process works on at once. One by default.
   *
   * The cap belongs to the caller, not here: a turn's cost is whatever the handler holds
   * for its lifetime -- a sandbox, in this system -- and this module has no idea what that
   * is. What it does guarantee is that no more than this many handlers are running, and
   * that a drain waits for all of them.
   */
  concurrency?: number
}

export const createRedisTurnQueue = (membership: QueueMembership): TurnQueue => {
  const client = new RedisClient(membership.url)
  const stream = streamOf(membership)
  const ready = ensureGroup(client, stream)

  let draining = false
  let consuming: Promise<void> | null = null

  const put = async (turn: TurnRequest): Promise<void> => {
    await ready
    await client.send('XADD', [stream, '*', 'turn', JSON.stringify(turn)])
  }

  /**
   * Loudly, because two loops on one connection would race for the same entries and each
   * would see a fraction of the work with nothing saying so.
   */
  const take = async (handle: (turn: TurnRequest) => Promise<void>): Promise<void> => {
    if (consuming !== null) throw new Error(`${membership.consumer} is already taking turns`)

    await ready
    consuming = consume(client, membership, handle, () => draining)
    await consuming
  }

  /**
   * Stops claiming new turns and waits for the one in flight.
   *
   * The client closes only after the loop has left. Closing it under a blocked read raises
   * an error from a call nobody is waiting on any more.
   */
  const close = async (): Promise<void> => {
    draining = true
    await consuming
    client.close()
  }

  return { put, take, close }
}

const consume = async (
  client: RedisClient,
  membership: QueueMembership,
  handle: (turn: TurnRequest) => Promise<void>,
  draining: () => boolean,
): Promise<void> => {
  const limit = membership.concurrency ?? 1
  const working = new Set<Promise<void>>()

  while (!draining()) {
    // At capacity: wait for a slot rather than claiming a turn this process cannot start.
    // A claimed entry is one nobody else in the group will be given, so claiming ahead is
    // how work ends up parked behind a busy consumer while another sits idle.
    if (working.size >= limit) {
      await Promise.race(working)
      continue
    }

    for (const claimed of await claimNext(client, membership.consumer, streamOf(membership))) {
      const work = settle(client, membership, handle, claimed)
      working.add(work)
      void work.finally(() => working.delete(work))
    }
  }

  // A drain is not done until every turn it started has ended. Exiting here would leave
  // sandboxes running and conversations half written (architecture.md §1).
  await Promise.all(working)
}

/**
 * Acknowledged only once the turn is through, so a process killed mid-turn leaves its entry
 * pending rather than losing it.
 */
const settle = async (
  client: RedisClient,
  membership: QueueMembership,
  handle: (turn: TurnRequest) => Promise<void>,
  claimed: { id: string; turn: TurnRequest },
): Promise<void> => {
  const done = await finished(handle, claimed.turn, membership.onFailed)
  if (!done) return

  await client.send('XACK', [streamOf(membership), GROUP, claimed.id])
}

/**
 * False when the turn failed, which leaves it claimed.
 *
 * The failure is reported and the loop carries on. One turn that cannot be finished must not
 * stop this process from taking the next: a sandbox that would not start, or a provider that
 * was down, says nothing about the turn behind it.
 */
const finished = async (
  handle: (turn: TurnRequest) => Promise<void>,
  turn: TurnRequest,
  onFailed: QueueMembership['onFailed'],
): Promise<boolean> => {
  try {
    await handle(turn)
    return true
  } catch (error) {
    onFailed(turn, error)
    return false
  }
}

/** Waits for one turn nobody in the group has been given yet, or for the block to lapse. */
const claimNext = async (
  client: RedisClient,
  consumer: string,
  stream: string,
): Promise<{ id: string; turn: TurnRequest }[]> => {
  // ">" means entries no one in this group has claimed.
  const read = (): Promise<unknown> =>
    client.send('XREADGROUP', [
      'GROUP',
      GROUP,
      consumer,
      'BLOCK',
      String(BLOCK_MS),
      'COUNT',
      '1',
      'STREAMS',
      stream,
      '>',
    ])

  try {
    return entriesOf(await read(), stream)
  } catch (error) {
    // The group existed at startup and does not any more. Redis restarting without
    // persistence does this, and so does anything that drops the key -- measured: running
    // the test suite against the same Redis killed a running agent outright.
    //
    // Recreating and retrying loses nothing. The group is bookkeeping, not the work: turns
    // already claimed are recovered from the pending list, and what was never claimed is
    // still in the stream.
    if (!String(error).includes('NOGROUP')) throw error

    await ensureGroup(client, stream)
    return entriesOf(await read(), stream)
  }
}

/**
 * The group has to exist before anyone reads, and creating it twice is not an error worth
 * propagating -- every process does this at startup and exactly one of them wins.
 */
const ensureGroup = async (client: RedisClient, stream: string): Promise<void> => {
  try {
    await client.send('XGROUP', ['CREATE', stream, GROUP, '$', 'MKSTREAM'])
  } catch (error) {
    if (!String(error).includes('BUSYGROUP')) throw error
  }
}

/**
 * XREADGROUP answers in the same shape XREAD does: a map keyed by stream name, each entry
 * `[id, [field, value, ...]]`. An entry that does not parse is left claimed rather than
 * acknowledged away, so it stays where a person can see it.
 */
const entriesOf = (reply: unknown, stream: string): { id: string; turn: TurnRequest }[] => {
  if (reply === null || typeof reply !== 'object') return []

  const forStream = (reply as Record<string, unknown>)[stream]
  if (!Array.isArray(forStream)) return []

  return forStream.flatMap((entry) => {
    if (!Array.isArray(entry)) return []

    const fields = (Array.isArray(entry[1]) ? entry[1] : []).map(String)
    const at = fields.indexOf('turn')
    const payload = at === -1 ? undefined : fields[at + 1]
    if (payload === undefined) return []

    const parsed = TurnRequest.safeParse(safeJson(payload))
    return parsed.success ? [{ id: String(entry[0]), turn: parsed.data }] : []
  })
}

const safeJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
