/**
 * The one script in this repository that can spend money twice.
 *
 * Every case here is a way a generation gets paid for and lost, or paid for twice. They run
 * the real script against a stand-in provider, because the thing being tested is what the
 * script does when an answer never arrives -- which is not something reading it can tell you.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SKILL = new URL('.', import.meta.url).pathname

/** What the stand-in provider does with the next submission. */
type Mood = 'answers' | 'accepts-then-goes-quiet' | 'refuses'

let mood: Mood = 'answers'
let listed: { id: string; created_at: number; model: string; duration: number }[] = []
let submits = 0

const provider = Bun.serve({
  port: 0,
  fetch: async (request) => {
    const url = new URL(request.url)

    if (request.method === 'POST' && url.pathname.endsWith('/tasks')) {
      submits += 1
      if (mood === 'refuses') return Response.json({ error: { message: 'no' } }, { status: 400 })

      const id = `cgt-fake-${submits}`
      // Accepted either way: the money is spent whether or not the caller hears about it.
      listed.unshift({
        id,
        created_at: Math.floor(Date.now() / 1000),
        model: 'doubao-seedance-2-0-260128',
        duration: 5,
      })

      // The response never arrives. Curl sees the connection close with nothing in it.
      if (mood === 'accepts-then-goes-quiet') return new Response(null, { status: 502 })

      return Response.json({ id })
    }

    if (request.method === 'GET' && url.pathname.endsWith('/tasks')) {
      return Response.json({ total: listed.length, items: listed })
    }

    // Polling one task: always finished, so a run that gets an id completes.
    const id = url.pathname.split('/').pop()
    return Response.json({ id, status: 'succeeded', content: { video_url: `${url.origin}/clip` } })
  },
})

let work = ''

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'generate-'))
  mood = 'answers'
  listed = []
  submits = 0
})

afterAll(() => provider.stop(true))

const run = async (): Promise<{ code: number; err: string }> => {
  const ran = Bun.spawn(['bash', join(SKILL, 'generate.sh'), 'a lake at dawn', '5'], {
    cwd: work,
    env: {
      ...process.env,
      VID_GATEWAY: `http://localhost:${provider.port}`,
      VID_TURN_TOKEN: 'a-turn-token',
      VID_SEEDANCE_MODEL: 'doubao-seedance-2-0-260128',
      SEEDANCE_WAIT_SECONDS: '10',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const err = await new Response(ran.stderr).text()
  return { code: await ran.exited, err }
}

const job = async (): Promise<Record<string, unknown> | null> => {
  try {
    return JSON.parse(await readFile(join(work, '.jobs/a-lake-at-dawn.json'), 'utf8'))
  } catch {
    return null
  }
}

describe('a submission whose answer never comes back', () => {
  test('leaves a record that money may already be spent', async () => {
    mood = 'accepts-then-goes-quiet'
    await run()

    // Written before the request. Without it the next turn has no idea this happened.
    expect(await job()).toMatchObject({ state: 'submitting' })
  })

  test('is picked up rather than paid for again', async () => {
    mood = 'accepts-then-goes-quiet'
    await run()

    mood = 'answers'
    const second = await run()

    expect(second.err).toContain('it did land')
    // One submission, not two: the second run adopted the task the first one bought.
    expect(submits).toBe(1)
    expect(await job()).toBeNull()
  })

  test('stops and says unknown when it cannot tell which task was ours', async () => {
    mood = 'accepts-then-goes-quiet'
    await run()

    // Someone else's generation, same model and length, same minute.
    listed.unshift({
      id: 'cgt-someone-else',
      created_at: Math.floor(Date.now() / 1000),
      model: 'doubao-seedance-2-0-260128',
      duration: 5,
    })

    const second = await run()

    expect(second.code).toBe(2)
    expect(second.err).toContain('unknown')
    // Guessing here is how you pay twice, or adopt a clip that is not yours.
    expect(submits).toBe(1)
  })
})

describe('a submission the provider refused', () => {
  test('leaves no record, because nothing was bought', async () => {
    mood = 'refuses'
    const ran = await run()

    expect(ran.code).toBe(1)
    expect(await job()).toBeNull()
  })
})

describe('a submission that worked', () => {
  test('writes the clip and clears the record', async () => {
    const ran = await run()

    expect(ran.code).toBe(0)
    expect(await job()).toBeNull()
    expect(await Bun.file(join(work, 'clips/a-lake-at-dawn.mp4')).exists()).toBe(true)
  })

  test('does not submit a second time when run again', async () => {
    await run()
    await run()

    // The first run finished and cleaned up; the second is a fresh, separate generation.
    expect(submits).toBe(2)
  })
})

afterAll(async () => {
  await rm(work, { recursive: true, force: true })
})
