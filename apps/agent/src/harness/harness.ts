/**
 * What every agent loop must provide.
 *
 * Thin today, because pi is the only implementation. It earns its own file anyway: it is
 * what `turn.ts` depends on, so `turn.ts` never imports an implementation, and the
 * dependency direction is something a grep can check rather than something to remember.
 *
 * The rule this port carries is the one that matters. **No vendor type crosses it.** A
 * harness's own vocabulary -- pi's `message_update`, another's equivalent -- stops at its
 * implementation file; what comes out is AG-UI, which is what the rest of the system,
 * including the browser, already speaks (architecture.md §6).
 *
 * pi is 0.85.1. That is the other reason this line is drawn now rather than later.
 */
import type { Event } from '@ag-ui/core'
import type { Projection } from '../projection'
import type { Sandbox } from '../sandbox/sandbox'

/** A skill's index entry. The content stays in the sandbox; only this reaches the model. */
export type SkillIndex = {
  name: string
  description: string
  /** Directory inside the sandbox holding SKILL.md and its scripts. */
  dir: string
}

export type ModelChoice = {
  baseUrl: string
  apiKey: string
  id: string
  contextWindow: number
  maxTokens: number
}

export type HarnessInput = {
  sandbox: Sandbox
  model: ModelChoice
  /** Must speak in sandbox paths. A host path here produces a command that cannot run. */
  systemPrompt: string
  skills: readonly SkillIndex[]
  /** Stored entries from earlier turns. Undefined starts a new conversation. */
  history: readonly unknown[] | undefined
  projection: Projection
  onEvent: (event: Event) => void
  /** Identifies this run. Becomes the AG-UI `runId` and prefixes every minted message id. */
  turnID: string
  threadID: string
}

export type Harness = {
  /**
   * One agent run, bracketed as AG-UI requires: RUN_STARTED, then exactly one of
   * RUN_FINISHED or RUN_ERROR. Those are not optional in the protocol -- they are what tells
   * a browser a turn began and how it ended, and a stream without them leaves the page
   * unable to tell working from finished.
   */
  run: (message: string) => Promise<void>
  /**
   * Interrupts a running turn. Delivered after the tool calls already in flight finish and
   * before the next model call -- people talk while the agent works, and a product that
   * makes them wait for a turn to end is a product they close.
   */
  steer: (message: string) => Promise<void>
  /**
   * What to persist so the next turn can carry on. Opaque on purpose: the shape belongs to
   * the implementation, and giving it a type of ours would be inventing a second format to
   * keep in sync with the first.
   */
  entries: () => readonly unknown[]
  cost: () => { tokens: number; usd: number }
  dispose: () => void
}

export type StartHarness = (input: HarnessInput) => Promise<Harness>
