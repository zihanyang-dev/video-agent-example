/**
 * One turn, start to finish.
 *
 * The boundary: it composes a sandbox, a harness, the projection and the three stores, and
 * owns no product policy of its own. Every rule it applies belongs to something it calls.
 *
 * It imports the two ports, never an implementation, so which sandbox and which harness are
 * decisions made once in `main.ts` and nowhere else.
 */
import { EventType, type Event, type Message } from '@ag-ui/core'
import { ARTIFACT, ArtifactContent } from '@vid/contract'
import type { TurnRequest } from '@vid/queue'
import type { Files, LiveStream, Messages, Sessions } from '@vid/store'
import { createProjection } from './projection'
import type { ModelChoice, SkillIndex, StartHarness } from './harness/harness'
import type { RentSandbox, Sandbox } from './sandbox/sandbox'

export type TurnParts = {
  rentSandbox: RentSandbox
  startHarness: StartHarness
  live: LiveStream
  messages: Messages
  sessions: Sessions
  files: Files
  model: ModelChoice
  sandboxImage: string
  sandboxNetwork: string
  /**
   * What this sandbox is allowed to know, decided per turn.
   *
   * A function rather than a value because part of it is: a skill script calls the gateway
   * with a token good only for the turn it is running in, so a token that leaked outlives
   * nothing (architecture.md §1). The agent is never told any of this exists (§8).
   */
  sandboxEnv: (request: TurnRequest) => Promise<Record<string, string>>
  skills: readonly SkillIndex[]
  systemPrompt: string
}

export type TakeTurn = (request: TurnRequest) => Promise<void>

export const createTurn = (parts: TurnParts): TakeTurn => {
  return async (request) => {
    const sandbox = await parts.rentSandbox({
      image: parts.sandboxImage,
      network: parts.sandboxNetwork,
      env: await parts.sandboxEnv(request),
    })

    try {
      // The question is recorded before any of it is attempted. A turn that fails still
      // leaves a conversation where someone can see what they asked for.
      await parts.messages.append(request.threadID, {
        id: `${request.turnID}:asked`,
        role: 'user',
        content: request.message,
      })

      await carryIn(parts.files, sandbox, request.threadID)
      await carrySkills(parts.files, sandbox)
      await runInside(parts, sandbox, request)
    } finally {
      // Whatever the turn managed to make is kept, including when the turn failed.
      //
      // A failed turn is exactly when this matters most. A script that told a provider to
      // start rendering writes the job id down before it waits; if that file went away with
      // the sandbox, the money is spent and nothing remembers what it bought -- so the next
      // attempt pays again. Measured: a turn that gave up seven seconds after submitting
      // lost the record of a generation that was still running (architecture.md §4).
      await salvage(parts, sandbox, request)

      // The sandbox is rented, not owned. It goes back whatever happened.
      await sandbox.destroy()
    }
  }
}

/**
 * Carries the workspace out, and says so rather than throwing if it cannot.
 *
 * This runs while a turn may already be failing. Throwing here would replace the reason the
 * turn failed with the reason we could not tidy up after it.
 */
const salvage = async (parts: TurnParts, sandbox: Sandbox, request: TurnRequest): Promise<void> => {
  try {
    await carryOut(parts.files, sandbox, request.threadID)
  } catch (error) {
    console.error(`turn ${request.turnID}: could not carry the workspace out`, error)
  }
}

const runInside = async (
  parts: TurnParts,
  sandbox: Sandbox,
  request: TurnRequest,
): Promise<void> => {
  const projection = createProjection()
  const deliver = createDelivery(parts, request.threadID, sandbox)

  const harness = await parts.startHarness({
    sandbox,
    model: parts.model,
    systemPrompt: parts.systemPrompt,
    skills: parts.skills,
    history: (await parts.sessions.read(request.threadID)) ?? undefined,
    projection,
    onEvent: (event) => deliver.take(event),
    turnID: request.turnID,
    threadID: request.threadID,
  })

  try {
    await harness.run(request.message)
  } finally {
    // A step that announced `running` and then died would otherwise spin on someone's
    // screen forever; the turn ending is the only evidence that it stopped.
    for (const abandoned of projection.settle()) deliver.take(abandoned)

    // Reported rather than thrown. A turn that already failed must not have its reason
    // replaced by whatever went wrong while writing down that it failed.
    await deliver.drain().catch((error: unknown) => {
      console.error(`turn ${request.turnID}: not everything was recorded`, error)
    })
    await parts.sessions.write(request.threadID, harness.entries())
    harness.dispose()
  }
}

/**
 * Where a visible event goes.
 *
 * Two destinations with different units: the stream carries fragments to whoever is
 * watching, the database carries completed things to whoever arrives tomorrow
 * (architecture.md §3.1).
 *
 * Text is assembled here because AG-UI's TEXT_MESSAGE_END carries no content -- it says a
 * message finished, not what it said.
 */
type Delivery = {
  take: (event: Event) => void
  drain: () => Promise<void>
}

const createDelivery = (parts: TurnParts, threadID: string, sandbox: Sandbox): Delivery => {
  const assembling = new Map<string, string>()
  const settled = new Set<string>()

  // Two chains, because the two stores order differently. The stream is one connection and
  // keeps the order its commands were issued in; the database is a pool and does not --
  // measured, and what came back was shuffled, which on a reload is a conversation whose
  // turns have swapped places. So each write waits for the one before it.
  let published: Promise<unknown> = Promise.resolve()
  let stored: Promise<unknown> = Promise.resolve()

  const take = (event: Event): void => {
    // Resolved once, awaited by both chains, so the two stores never disagree about what an
    // event said.
    const ready = deliverable(parts, threadID, sandbox, event)

    published = published.then(async () => {
      const settledEvent = await ready
      if (settledEvent !== null) await parts.live.publish(threadID, settledEvent)
    })

    stored = stored.then(async () => {
      const settledEvent = await ready
      if (settledEvent === null) return

      const durable = keep(settledEvent, assembling)
      if (durable === null) return

      const seen = settled.has(durable.id)
      settled.add(durable.id)
      await (seen
        ? parts.messages.replace(threadID, durable)
        : parts.messages.append(threadID, durable))
    })
  }

  /** Every write started during the turn has landed before the turn reports done. */
  const drain = async (): Promise<void> => {
    await Promise.all([published, stored])
  }

  return { take, drain }
}

/**
 * Turns what a script announced into what a person may receive. Null drops the event.
 *
 * Only artifacts need this. A script announces the workspace path of the thing it made --
 * it has no credential and cannot mint anything -- and the file leaves here as a short-lived
 * URL. The file is carried out now rather than at the end of the turn, because a person
 * watching sees the artifact appear and will click it immediately.
 *
 * A path that cannot be turned into a URL is dropped rather than forwarded. Passing it on
 * would put an internal path on a screen, which is the one thing the contract exists to
 * prevent, and a link to it would be a link to nothing anyway.
 */
const deliverable = async (
  parts: TurnParts,
  threadID: string,
  sandbox: Sandbox,
  event: Event,
): Promise<Event | null> => {
  if (event.type !== EventType.ACTIVITY_SNAPSHOT || event.activityType !== ARTIFACT) return event

  const announced = ArtifactContent.safeParse(event.content)
  if (!announced.success) return null

  const path = announced.data.url.replace(/^\/+/, '')
  const key = `${workspaceOf(threadID)}${path}`

  try {
    await parts.files.put(key, await sandbox.readFile(`${sandbox.roots.sandbox}/${path}`))
    return { ...event, content: { ...announced.data, url: await parts.files.downloadUrl(key) } }
  } catch (error) {
    console.error(`turn on ${threadID}: announced ${path}, which could not be delivered`, error)
    return null
  }
}

/** Null for anything a page reload should not replay. */
const keep = (event: Event, assembling: Map<string, string>): Message | null => {
  if (event.type === EventType.TEXT_MESSAGE_CONTENT) {
    assembling.set(event.messageId, (assembling.get(event.messageId) ?? '') + event.delta)
    return null
  }

  if (event.type === EventType.TEXT_MESSAGE_END) {
    const text = assembling.get(event.messageId) ?? ''
    assembling.delete(event.messageId)
    return { id: event.messageId, role: 'assistant', content: text }
  }

  if (event.type === EventType.ACTIVITY_SNAPSHOT) {
    // A running step is not kept: tomorrow it would be a spinner nobody will ever stop.
    if (isRunning(event.content)) return null
    return {
      id: event.messageId,
      role: 'activity',
      activityType: event.activityType,
      content: event.content,
    }
  }

  return null
}

const isRunning = (content: Record<string, unknown>): boolean => content['state'] === 'running'

/**
 * The thread's files, into a machine that has none.
 *
 * This is what makes a conversation feel continuous across a sandbox that only lives for one
 * turn: the agent's notes, its cut list, what it decided about shot three, are files.
 */
const carryIn = async (files: Files, sandbox: Sandbox, threadID: string): Promise<void> => {
  await copyInto(files, sandbox, workspaceOf(threadID), '')
}

const copyInto = async (
  files: Files,
  sandbox: Sandbox,
  prefix: string,
  into: string,
): Promise<void> => {
  const keys = await files.list(prefix)

  // Directories first, and only the ones actually needed. A file written into a directory
  // that is not there fails, and object storage has no directories to tell us about.
  const wanted = new Set(
    keys
      .map((key) => `${into}${key.slice(prefix.length)}`)
      .map((path) => path.slice(0, path.lastIndexOf('/')))
      .filter((directory) => directory !== ''),
  )
  for (const directory of [...wanted].sort()) {
    await sandbox.mkdir(`${sandbox.roots.sandbox}/${directory}`)
  }

  for (const key of keys) {
    const bytes = await files.get(key)
    await sandbox.writeFile(`${sandbox.roots.sandbox}/${into}${key.slice(prefix.length)}`, bytes)
  }
}

/**
 * Skills, into the same sandbox, and they never come back out.
 *
 * Their truth is a git repository that CI publishes, so a sandbox writing to them would be
 * writing to a copy (architecture.md §7). Carried in beside the thread's own files because
 * that is where the agent looks -- it finds them by reading the directory, not by being
 * handed a list.
 */
const carrySkills = async (files: Files, sandbox: Sandbox): Promise<void> => {
  await copyInto(files, sandbox, SKILLS_PREFIX, `${SKILLS_DIR}/`)
}

const carryOut = async (files: Files, sandbox: Sandbox, threadID: string): Promise<void> => {
  const prefix = workspaceOf(threadID)

  for (const path of await sandbox.list()) {
    // Skills came from object storage and are read-only here. Writing them back would make
    // this thread's copy the next turn's source.
    if (path === SKILLS_DIR || path.startsWith(`${SKILLS_DIR}/`)) continue
    const bytes = await sandbox.readFile(`${sandbox.roots.sandbox}/${path}`)
    await files.put(`${prefix}${path}`, bytes)
  }
}

const workspaceOf = (threadID: string): string => `threads/${threadID}/`

const SKILLS_PREFIX = 'skills/'
const SKILLS_DIR = 'skills'
