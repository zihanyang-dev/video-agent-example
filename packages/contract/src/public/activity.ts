/**
 * What a user is allowed to see, in the one vocabulary that is ours.
 *
 * The envelope is not ours: AG-UI defines the events and the durable `Message[]`, and an
 * `ActivityMessage` carries `activityType` and `content` that the protocol deliberately
 * leaves to the producer ("An open string: the set is the producer's"). This file is that
 * set, and nothing else.
 *
 * Four types, because there are four things a person can do something about: see what is
 * intended before it happens, watch one piece of it run, look at what came out, answer a
 * question only they can answer. A fifth is added when a fifth kind of user action exists,
 * not when a fifth kind of internal event does.
 *
 * `plan` earned its place rather than being added for tidiness. A ten-minute job made of
 * seven generations shows as seven steps arriving one at a time, and from the outside that
 * is indistinguishable from a job that has lost its way: you cannot tell what is left, so
 * you cannot tell whether to stop it. The plan is what makes interrupting an informed act.
 *
 * These shapes contain user-facing content, not paths, shell commands or tool metadata.
 * String schemas cannot enforce that distinction: producers choose public wording, and the
 * server projects execution events into this vocabulary before the web app receives them.
 *
 * AG-UI also defines TOOL_CALL_START / ARGS / END / RESULT. The server does not publish them.
 * Skill announcements become activities through the agent's progress translation; observing
 * a tool call alone does not make that call a public message (architecture.md §7).
 */
import { z } from 'zod'

/** What the agent means to do, before and while it does it. */
export const PLAN = 'plan'
/** Work the agent is doing that a person is waiting on. */
export const STEP = 'step'
/** Something the agent produced that a person can open. */
export const ARTIFACT = 'artifact'
/** A decision only a person can make. */
export const ASK = 'ask'

/**
 * One line of a plan.
 *
 * `skipped` is a real outcome and not a failure: a plan written before the work is a guess,
 * and finding out a shot is unnecessary is the plan doing its job. Saying so is better than
 * quietly leaving it unfinished, which reads as something that went wrong.
 */
export const PlanItem = z.object({
  label: z.string().min(1),
  state: z.enum(['todo', 'doing', 'done', 'skipped']),
})

export const PlanContent = z.object({
  items: z.array(PlanItem).min(1),
})

export const StepContent = z.object({
  /** Already written for a person. Authored by whoever wrote the skill script. */
  label: z.string().min(1),
  state: z.enum(['running', 'done', 'failed']),
  /**
   * Public explanation supplied by the producer, not raw tool output. Internal retries
   * need no new activity; a final failed state can explain what the person can do next.
   */
  detail: z.string().optional(),
})

export const ArtifactContent = z.object({
  /**
   * The server signs a short-lived download for the stored object key when presenting it.
   * Execution events carry the key instead, so replay does not depend on an expired URL.
   */
  url: z.string().min(1),
  role: z.enum(['preview', 'final']),
})

export const AskContent = z.object({
  question: z.string().min(1),
  options: z.array(z.string()),
  /**
   * An answered snapshot can replace the same activity rather than append a second question.
   * Null represents an unanswered question; the schema does not prescribe how the producer
   * receives an answer.
   */
  answer: z.string().nullable(),
})

/**
 * Narrows an activity by its type. A reader gets the right content shape without knowing
 * which producer wrote it.
 */
export const Activity = z.discriminatedUnion('activityType', [
  z.object({ activityType: z.literal(PLAN), content: PlanContent }),
  z.object({ activityType: z.literal(STEP), content: StepContent }),
  z.object({ activityType: z.literal(ARTIFACT), content: ArtifactContent }),
  z.object({ activityType: z.literal(ASK), content: AskContent }),
])

export type PlanItem = z.infer<typeof PlanItem>
export type PlanContent = z.infer<typeof PlanContent>
export type StepContent = z.infer<typeof StepContent>
export type ArtifactContent = z.infer<typeof ArtifactContent>
export type AskContent = z.infer<typeof AskContent>
export type Activity = z.infer<typeof Activity>
