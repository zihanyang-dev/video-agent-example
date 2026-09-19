/**
 * What a turn promises even when it goes wrong.
 *
 * Every case here is about a failed turn, because that is when the promises matter and when
 * they were actually broken: a turn that gave up seven seconds after telling a provider to
 * start rendering lost the record of what it had bought, and the next attempt would have
 * paid again.
 */
import { EventType, type Event, type Message } from '@ag-ui/core'
import { ARTIFACT } from '@vid/contract'
import type { TurnRequest } from '@vid/queue'
import type { Files, LiveStream, Messages, Sessions, Thread } from '@vid/store'
import { describe, expect, test } from 'bun:test'
import type { Harness, HarnessInput, StartHarness } from './harness/harness'
import type { RentSandbox, Sandbox } from './sandbox/sandbox'
import { createTurn, type TurnParts } from './turn'

const request: TurnRequest = {
  threadID: 't1',
  userID: 'owner',
  turnID: 'turn-1',
  message: 'make me an opener',
}

/** A sandbox whose files live in a map, so a test can see what was left in it. */
const fakeSandbox = (inside: Map<string, Uint8Array>) => {
  let destroyed = false
  const sandbox: Sandbox = {
    roots: { host: '/tmp/host', sandbox: '/work' },
    exec: async () => ({ exitCode: 0 }),
    readFile: async (path) => inside.get(path) ?? new Uint8Array(),
    access: async () => {},
    mimeType: async () => null,
    writeFile: async (path, bytes) => {
      inside.set(path, bytes)
    },
    mkdir: async () => {},
    list: async () => [...inside.keys()].map((path) => path.replace('/work/', '')),
    destroy: async () => {
      destroyed = true
    },
  }
  return { sandbox, wasDestroyed: () => destroyed }
}

const parts = (
  overrides: {
    rentSandbox?: RentSandbox
    startHarness?: StartHarness
    stored?: Map<string, Uint8Array>
    written?: Message[]
    shown?: Event[]
  } = {},
): TurnParts => {
  const stored = overrides.stored ?? new Map<string, Uint8Array>()
  const written = overrides.written ?? []

  const files: Files = {
    list: async (prefix) => [...stored.keys()].filter((key) => key.startsWith(prefix)),
    get: async (key) => stored.get(key) ?? new Uint8Array(),
    put: async (key, bytes) => {
      stored.set(key, bytes)
    },
    uploadUrl: async () => 'https://objects/upload',
    downloadUrl: async () => 'https://objects/download',
  }

  const messages: Messages = {
    thread: async (): Promise<Thread | null> => ({ threadID: 't1', userID: 'owner' }),
    open: async () => {},
    read: async () => written,
    append: async (_thread, message) => {
      written.push(message)
    },
    replace: async (_thread, message) => {
      written.push(message)
    },
  }

  const sessions: Sessions = { read: async () => null, write: async () => {} }
  const live: LiveStream = {
    publish: async (_thread, event) => {
      overrides.shown?.push(event)
    },
    read: async function* () {
      // Nothing reads the stream in these cases.
    },
  }

  return {
    rentSandbox: overrides.rentSandbox ?? (async () => fakeSandbox(new Map()).sandbox),
    startHarness: overrides.startHarness ?? (async () => quietHarness()),
    live,
    messages,
    sessions,
    files,
    model: { baseUrl: 'http://x', apiKey: 'k', id: 'm', contextWindow: 1, maxTokens: 1 },
    sandboxImage: 'image',
    sandboxNetwork: 'net',
    sandboxEnv: async () => ({}),
    skills: [],
    systemPrompt: 'be a video editor',
  }
}

const quietHarness = (run?: () => Promise<void>): Harness => ({
  run: run ?? (async () => {}),
  steer: async () => {},
  entries: () => [],
  cost: () => ({ tokens: 0, usd: 0 }),
  dispose: () => {},
})

describe('a turn that failed, what it hangs on to', () => {
  test('still keeps what the sandbox managed to write', async () => {
    const inside = new Map<string, Uint8Array>()
    const stored = new Map<string, Uint8Array>()
    const { sandbox } = fakeSandbox(inside)

    const take = createTurn(
      parts({
        stored,
        rentSandbox: async () => sandbox,
        startHarness: async (input: HarnessInput) => {
          // What a generation script does: write down the job before waiting on it.
          await input.sandbox.writeFile(
            '/work/.jobs/opener.json',
            new TextEncoder().encode('{"id":"cgt-1"}'),
          )
          return quietHarness(async () => {
            throw new Error('the turn gave up while the provider was still rendering')
          })
        },
      }),
    )

    await expect(take(request)).rejects.toThrow('gave up')

    // Without this the money is spent and nothing remembers what it bought.
    expect([...stored.keys()]).toContain('threads/t1/.jobs/opener.json')
  })

  test('still returns the sandbox', async () => {
    const { sandbox, wasDestroyed } = fakeSandbox(new Map())
    const take = createTurn(
      parts({
        rentSandbox: async () => sandbox,
        startHarness: async () =>
          quietHarness(async () => {
            throw new Error('anything')
          }),
      }),
    )

    await expect(take(request)).rejects.toThrow()

    expect(wasDestroyed()).toBe(true)
  })
})

describe('a turn that failed, what it says', () => {
  test('still leaves the question someone asked', async () => {
    const written: Message[] = []
    const take = createTurn(
      parts({
        written,
        startHarness: async () =>
          quietHarness(async () => {
            throw new Error('anything')
          }),
      }),
    )

    await expect(take(request)).rejects.toThrow()

    expect(written[0]).toMatchObject({ role: 'user', content: 'make me an opener' })
  })

  test('reports its own reason, not the reason tidying up went wrong', async () => {
    const { sandbox } = fakeSandbox(new Map())
    const broken: Sandbox = {
      ...sandbox,
      list: async () => {
        throw new Error('the sandbox is unreachable')
      },
    }

    const take = createTurn(
      parts({
        rentSandbox: async () => broken,
        startHarness: async () =>
          quietHarness(async () => {
            throw new Error('the model refused')
          }),
      }),
    )

    await expect(take(request)).rejects.toThrow('the model refused')
  })
})

describe('a turn that worked', () => {
  test('carries out what the sandbox produced', async () => {
    const inside = new Map<string, Uint8Array>()
    const stored = new Map<string, Uint8Array>()
    const { sandbox } = fakeSandbox(inside)

    const take = createTurn(
      parts({
        stored,
        rentSandbox: async () => sandbox,
        startHarness: async (input: HarnessInput) => {
          await input.sandbox.writeFile('/work/opener.mp4', new Uint8Array([1, 2, 3]))
          return quietHarness()
        },
      }),
    )

    await take(request)

    expect([...stored.keys()]).toContain('threads/t1/opener.mp4')
  })

  test('does not carry skills back out, because their source is elsewhere', async () => {
    const inside = new Map<string, Uint8Array>()
    const stored = new Map<string, Uint8Array>([
      ['skills/generate-clip/SKILL.md', new TextEncoder().encode('---\nname: x\n---')],
    ])
    const { sandbox } = fakeSandbox(inside)

    const take = createTurn(parts({ stored, rentSandbox: async () => sandbox }))
    await take(request)

    expect([...stored.keys()].filter((key) => key.startsWith('threads/t1/skills'))).toEqual([])
  })
})

/** What `deliver.sh` prints. The script is the only thing that may put this on a screen. */
const announceArtifact = (path: string): Event => ({
  type: EventType.ACTIVITY_SNAPSHOT,
  messageId: `artifact:${path}`,
  activityType: ARTIFACT,
  content: { url: path, role: 'final' },
})

describe('something the agent made', () => {
  test('reaches a person as a link, never as a path on this machine', async () => {
    const shown: Event[] = []
    const inside = new Map<string, Uint8Array>()
    const { sandbox } = fakeSandbox(inside)

    const take = createTurn(
      parts({
        shown,
        rentSandbox: async () => sandbox,
        startHarness: async (input: HarnessInput) => {
          await input.sandbox.writeFile('/work/opener.mp4', new Uint8Array([1, 2, 3]))
          return quietHarness(async () => {
            input.onEvent(announceArtifact('opener.mp4'))
          })
        },
      }),
    )

    await take(request)

    const artifact = shown.find((event) => event.type === EventType.ACTIVITY_SNAPSHOT)
    expect(artifact).toMatchObject({ content: { url: 'https://objects/download' } })
  })

  test('is not shown at all when the file it named is not there', async () => {
    const shown: Event[] = []
    const { sandbox } = fakeSandbox(new Map())
    const missing: Sandbox = {
      ...sandbox,
      readFile: async () => {
        throw new Error('no such file')
      },
    }

    const take = createTurn(
      parts({
        shown,
        rentSandbox: async () => missing,
        startHarness: async (input: HarnessInput) =>
          quietHarness(async () => {
            input.onEvent(announceArtifact('never-made.mp4'))
          }),
      }),
    )

    await take(request)

    // Better than a link to nothing, and it keeps the path off the screen either way.
    expect(shown.filter((event) => event.type === EventType.ACTIVITY_SNAPSHOT)).toEqual([])
  })
})
