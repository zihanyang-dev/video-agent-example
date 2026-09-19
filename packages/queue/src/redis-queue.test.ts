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

const join = (consumer: string): TurnQueue => {
  const queue = createRedisTurnQueue({
    url,
    consumer,
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
  const pending = await admin.send('XPENDING', ['turns', 'agents'])
  return Array.isArray(pending) ? Number(pending[0]) : 0
}

beforeEach(async () => {
  failures = []
  joined = []
  await admin.send('DEL', ['turns'])
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
