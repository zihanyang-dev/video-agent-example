/**
 * One turn, start to finish.
 *
 * The boundary: it composes a sandbox, a harness, the projection and the three stores, and
 * owns no product policy of its own. Every rule it applies belongs to something it calls.
 *
 * It imports the two ports, never an implementation, so which sandbox and which harness are
 * decisions made once in `main.ts` and nowhere else.
 */
import type { TurnRequest } from '@vid/queue'
import type { Files, LiveStream, Messages, Sessions } from '@vid/store'
import { createDelivery } from './delivery'
import type { ModelChoice, SkillIndex, StartHarness } from './harness/harness'
import type { InFlight } from './in-flight'
import { createProjection } from './projection'
import type { RentSandbox, Sandbox } from './sandbox/sandbox'
import { carryIn, carryOut, carrySkills } from './workspace'

export type TurnParts = {
  rentSandbox: RentSandbox
  startHarness: StartHarness
  /**
   * Who owns which thread while a turn is running.
   *
   * A turn registers here for its whole life, which is what stops a second one starting on
   * the same thread and what lets a message typed while it works reach it (`in-flight.ts`).
   */
  inFlight: InFlight
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

  // From here until the run is over, this thread is ours and anything else said on it comes
  // to this harness instead of waiting for a turn of its own.
  const release = parts.inFlight.claim(request.threadID, harness)

  // Held rather than thrown, so that whatever went wrong first is what the turn reports.
  // A turn that failed must not have its reason replaced by what went wrong while writing
  // down that it failed.
  let ran: unknown = null

  try {
    await harness.run(request.message)
  } catch (error) {
    ran = error
  } finally {
    // Before anything else is awaited: a steer decided after this point is refused and run
    // as its own turn, rather than handed to a harness that is about to be disposed.
    release()
  }

  const recorded = await close({ parts, request, projection, deliver, harness })

  if (ran !== null) throw ran

  // Nothing above threw, so the work happened -- and then failed to be written down. That
  // is not a turn that succeeded: the person would be told it went well and find nothing
  // there tomorrow. Measured: a second turn delivering the same artifact hit the primary
  // key, every write behind it was skipped, and the turn returned as though nothing was
  // wrong.
  if (recorded !== null) throw recorded
}

/**
 * Closes a turn out, whether or not it went well.
 *
 * Returns what went wrong writing the turn down, rather than throwing it: the caller holds
 * the reason the turn itself failed, and that reason wins.
 */
const close = async (of: {
  parts: TurnParts
  request: TurnRequest
  projection: ReturnType<typeof createProjection>
  deliver: ReturnType<typeof createDelivery>
  harness: Awaited<ReturnType<StartHarness>>
}): Promise<unknown> => {
  // A step that announced `running` and then died would otherwise spin on someone's screen
  // forever; the turn ending is the only evidence that it stopped.
  for (const abandoned of of.projection.settle()) of.deliver.take(abandoned)

  let recorded: unknown = null
  try {
    await of.deliver.drain()
  } catch (error) {
    recorded = error
  }

  await of.parts.sessions.write(of.request.threadID, of.harness.entries())
  of.harness.dispose()
  return recorded
}
