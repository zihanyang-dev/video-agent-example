/**
 * Against a real Postgres, because every bug these cover was one a fake would have hidden:
 * ordering comes from the database, the upsert race is the pool's doing, and cascade is a
 * constraint no stub enforces.
 *
 * Needs `docker compose -f deploy/docker/compose.yaml up -d db` and `bun run migrate`.
 */
import type { Message } from '@ag-ui/core'
import { SQL } from 'bun'
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { createPostgresMessages } from './postgres-messages'
import { createPostgresSessions } from './postgres-sessions'

const sql = new SQL(process.env['DATABASE_URL'] ?? 'postgres://vid:vid@localhost:5432/vid')
const messages = createPostgresMessages(sql)
const sessions = createPostgresSessions(sql)

let thread = ''

beforeEach(async () => {
  thread = `t-${crypto.randomUUID()}`
  await sql`insert into threads (thread_id, user_id) values (${thread}, ${'owner'})`
})

afterAll(async () => {
  await sql.close()
})

const said = (id: string, text: string): Message => ({ id, role: 'assistant', content: text })

const activity = (state: string): Message => ({
  id: 'render',
  role: 'activity',
  activityType: 'step',
  content: { label: 'Rendering “montage”', state },
})

const contents = (stored: readonly Message[]): string[] =>
  stored.map((message) => String((message as { content: unknown }).content))

describe('reading a conversation back', () => {
  test('a thread nobody created is absent rather than an error', async () => {
    expect(await messages.thread('never-existed')).toBeNull()
  })

  test('messages come back in the order they were written', async () => {
    await messages.append(thread, said('m1', 'first'))
    await messages.append(thread, said('m2', 'second'))
    await messages.append(thread, said('m3', 'third'))

    expect(contents(await messages.read(thread))).toEqual(['first', 'second', 'third'])
  })

  /**
   * The one that was actually broken. Writes were fired and collected at the end, which the
   * stream tolerates and a pooled database does not -- a reload showed a conversation whose
   * turns had swapped places.
   */
  test('order survives writes issued back to back', async () => {
    let chain: Promise<unknown> = Promise.resolve()
    for (let n = 0; n < 40; n++) {
      chain = chain.then(() => messages.append(thread, said(`m${n}`, String(n))))
    }
    await chain

    expect(contents(await messages.read(thread))).toEqual(
      Array.from({ length: 40 }, (_unused, n) => String(n)),
    )
  })

  test('two threads can hold the same message id', async () => {
    const other = `t-${crypto.randomUUID()}`
    await sql`insert into threads (thread_id, user_id) values (${other}, ${'someone'})`

    await messages.append(thread, said('m1', 'ours'))
    await messages.append(other, said('m1', 'theirs'))

    expect(contents(await messages.read(thread))).toEqual(['ours'])
  })
})

describe('an activity settling', () => {
  test('replaces rather than appearing twice', async () => {
    await messages.append(thread, activity('running'))
    await messages.replace(thread, activity('done'))

    const stored = await messages.read(thread)
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ content: { state: 'done' } })
  })

  /** The two calls race when a script announces and settles in one burst of output. */
  test('works even when the first write never happened', async () => {
    await messages.replace(thread, activity('done'))

    expect(await messages.read(thread)).toHaveLength(1)
  })

  test('text outside ascii survives the round trip', async () => {
    await messages.append(thread, activity('done'))

    const [stored] = await messages.read(thread)
    expect(stored).toMatchObject({ content: { label: 'Rendering “montage”' } })
  })
})

describe('the agent’s own record', () => {
  test('a thread that has never run a turn has none', async () => {
    expect(await sessions.read(thread)).toBeNull()
  })

  test('a long history survives whole', async () => {
    const entries = Array.from({ length: 300 }, (_unused, n) => ({ n, text: 'x'.repeat(100) }))

    await sessions.write(thread, entries)

    expect(await sessions.read(thread)).toHaveLength(300)
  })

  test('a later write replaces rather than appends', async () => {
    await sessions.write(thread, [{ first: true }, { second: true }])
    await sessions.write(thread, [{ only: true }])

    expect(await sessions.read(thread)).toHaveLength(1)
  })
})

test('deleting a thread takes everything of its with it', async () => {
  await messages.append(thread, said('m1', 'something'))
  await sessions.write(thread, [{ entry: 1 }])

  await sql`delete from threads where thread_id = ${thread}`

  const [left] = await sql`
    select (select count(*) from messages where thread_id = ${thread})
         + (select count(*) from sessions where thread_id = ${thread}) as n
  `
  expect(Number(left.n)).toBe(0)
})
