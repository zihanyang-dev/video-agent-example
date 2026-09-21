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
 * Nothing here may carry an internal identifier -- no file paths, no shell commands, no tool
 * names, no model names, no skill names. That is enforced by what this file is allowed to
 * contain, because this is the only package of ours the web app imports.
 *
 * AG-UI also defines TOOL_CALL_START / ARGS / END / RESULT. We emit none of them: that would
 * put `bash` and `ffmpeg` on a person's screen. What a user sees comes from a skill script
 * announcing it, never from a tool call being observed (architecture.md §8).
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
   * Shown only when a person can act on it. A failure the script recovered from never
   * reaches here -- the script announces `failed` when it has given up, not when it retries.
   */
  detail: z.string().optional(),
})

export const ArtifactContent = z.object({
  /**
   * Short-lived, minted by us against object storage. The agent never learns it: the script
   * uploads through a URL it was handed, and announces the result (architecture.md §8).
   */
  url: z.string().min(1),
  role: z.enum(['preview', 'final']),
})

export const AskContent = z.object({
  question: z.string().min(1),
  options: z.array(z.string()),
  /**
   * Null until answered. The answer arrives as a second snapshot of the same activity, which
   * is why it lives in the content rather than in a separate event: ACTIVITY_SNAPSHOT
   * replaces by default, so asked and answered are one message, not two.
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
