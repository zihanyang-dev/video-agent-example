/**
 * What the queue promises: each turn is worked once, a turn that failed stays where a
 * person can find it, and nothing is dropped because something else went wrong.
 *
 * Two of these cover defects a run found rather than a review: a handler that threw took
 * the whole consumer down with it, and a second `take` silently started a rival loop.
 *
 * Needs `docker compose -f deploy/docker/compose.yaml up -d redis`.
 */
import { RedisClient } from 'bun'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createRedisTurnQueue } from './redis-queue'
import type { TurnQueue, TurnRequest } from './turn-request'

const url = process.env['REDIS_URL'] ?? 'redis://localhost:6379'
const admin = new RedisClient(url)

let joined: TurnQueue[] = []
let failures: string[] = []

/**
 * A stream of this run's own.
 *
 * The default one belongs to whatever agent is running on this machine. Sharing it means
 * taking each other's work, which is exactly what happened: an agent claimed ten of these
 * turns and failed every one on threads that only exist in here.
 */
const STREAM = `turns-test-${crypto.randomUUID()}`

const join = (consumer: string): TurnQueue => {
  const queue = createRedisTurnQueue({
    url,
    consumer,
    stream: STREAM,
    onFailed: (turn) => failures.push(turn.turnID),
  })
  joined.push(queue)
  return queue
}

const turn = (n: number): TurnRequest => ({
  threadID: `t${n}`,
  userID: 'owner',
  turnID: `turn-${n}`,
  message: `do ${n}`,
})

/** How many entries the group is still holding for someone. */
const stillClaimed = async (): Promise<number> => {
  const pending = await admin.send('XPENDING', [STREAM, 'agents'])
  return Array.isArray(pending) ? Number(pending[0]) : 0
}

beforeEach(async () => {
  failures = []
  joined = []
  await admin.send('DEL', [STREAM])
})

afterEach(async () => {
  await Promise.all(joined.map((queue) => queue.close()))
})

describe('two processes sharing the work', () => {
  test('each turn is worked exactly once, by one of them', async () => {
    const byA: string[] = []
    const byB: string[] = []
    const a = join('agent-a')
    const b = join('agent-b')

    void a.take(async (claimed) => {
      byA.push(claimed.turnID)
      await Bun.sleep(20)
    })
    void b.take(async (claimed) => {
      byB.push(claimed.turnID)
      await Bun.sleep(20)
    })
    await Bun.sleep(100)
    for (let n = 0; n < 12; n++) await a.put(turn(n))
    await Bun.sleep(1_200)

    const worked = [...byA, ...byB]
    expect(worked).toHaveLength(12)
    expect(new Set(worked).size).toBe(12)
    expect(byA.length).toBeGreaterThan(0)
    expect(byB.length).toBeGreaterThan(0)
  }, 10_000)

  test('a turn that finished is not left claimed', async () => {
    const queue = join('agent-a')
    void queue.take(async () => {})
    await queue.put(turn(1))
    await Bun.sleep(600)

    expect(await stillClaimed()).toBe(0)
  })
})

describe('a turn that failed', () => {
  test('stays claimed rather than disappearing', async () => {
    const queue = join('agent-c')
    void queue.take(async () => {
      throw new Error('the sandbox never started')
    })
    await queue.put(turn(99))
    await Bun.sleep(600)

    // Never replayed on its own: it may already have told a provider to spend.
    expect(await stillClaimed()).toBe(1)
  })

  test('is reported, because the pending list is nobody’s notification', async () => {
    const queue = join('agent-c')
    void queue.take(async () => {
      throw new Error('the sandbox never started')
    })
    await queue.put(turn(99))
    await Bun.sleep(600)

    expect(failures).toContain('turn-99')
  })

  test('does not stop the next one being taken', async () => {
    const queue = join('agent-c')
    void queue.take(async () => {
      throw new Error('the sandbox never started')
    })

    await queue.put(turn(1))
    await Bun.sleep(400)
    await queue.put(turn(2))
    await Bun.sleep(600)

    expect(failures).toEqual(['turn-1', 'turn-2'])
  })
})

describe('the stream disappearing underneath a running agent', () => {
  test('does not stop it working, because the group is bookkeeping and not the work', async () => {
    const worked: string[] = []
    const queue = join('agent-survivor')
    void queue.take(async (claimed) => {
      worked.push(claimed.turnID)
    })
    await Bun.sleep(100)

    // What a Redis restart without persistence leaves behind, and what running this suite
    // against a shared Redis did to a live agent.
    await admin.send('DEL', [STREAM])
    await Bun.sleep(400)

    await queue.put(turn(7))
    await Bun.sleep(600)

    expect(worked).toEqual(['turn-7'])
  }, 10_000)
})

describe('shutting down', () => {
  test('waits for the turn in flight', async () => {
    const queue = join('agent-d')
    let finished = false
    void queue.take(async () => {
      await Bun.sleep(400)
      finished = true
    })
    await queue.put(turn(1))
    await Bun.sleep(150)

    await queue.close()

    expect(finished).toBe(true)
  })
})

describe('taking twice on one queue', () => {
  test('fails loudly, because two loops would each see a fraction of the work', async () => {
    const queue = join('agent-e')
    void queue.take(async () => {})
    await Bun.sleep(100)

    await expect(queue.take(async () => {})).rejects.toThrow('already taking turns')
  })
})
