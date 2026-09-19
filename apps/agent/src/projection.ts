/**
 * The rule about what a person is allowed to see.
 *
 * One direction only: nothing is visible until a rule here makes it visible. The agent
 * reads files, greps skills, runs ffmpeg, retries a failed upload -- none of that reaches a
 * screen, because none of it has a rule. Starting from "hide it if it looks internal" leaks
 * the first time a vendor adds a stream part (architecture.md §6).
 *
 * The only way in is a skill script printing a line. That is the whole interface between a
 * skill and a person's screen, which is why it lives here rather than in the skills
 * repository: the rule about what may reach a user is ours, the wording is the author's.
 *
 * The agent is never told this convention exists. It runs scripts; the scripts announce
 * (architecture.md §8).
 *
 * No pi here, deliberately. Swapping the harness must not change what a person sees, so the
 * harness adapter translates its vendor's events and calls in here for the part that is
 * ours.
 */
import { EventType, type Event } from '@ag-ui/core'
import { Activity, STEP } from '@vid/contract'
import { z } from 'zod'

/**
 * A script announces by printing exactly this, then one JSON object:
 *
 *     ::vid {"id":"render-1","activityType":"step","content":{"label":"Rendering","state":"running"}}
 *
 * A prefix and a JSON object, not a key=value grammar of our own. A grammar is a parser,
 * and a parser is a thing to get wrong.
 */
export const ANNOUNCE_PREFIX = '::vid '

/**
 * `id` is the AG-UI message id rather than part of the payload: settling an activity means
 * sending the same id again, because ACTIVITY_SNAPSHOT replaces by default. Running and
 * done, asked and answered, are one message each.
 */
const Announcement = z.intersection(z.object({ id: z.string().min(1) }), Activity)

type Announcement = z.infer<typeof Announcement>

/** Null for every line that is not a well-formed announcement, malformed ones included. */
export const readAnnouncement = (line: string): Announcement | null => {
  if (!line.startsWith(ANNOUNCE_PREFIX)) return null

  const payload = parseJson(line.slice(ANNOUNCE_PREFIX.length))
  if (payload === null) return null

  const result = Announcement.safeParse(payload)
  return result.success ? result.data : null
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    // Half a line, from two writes interleaving. Dropping it is right: the script owns the
    // retry, and a person would rather see nothing than a fragment.
    return null
  }
}

export type Projection = {
  /**
   * Everything one command has printed so far. Cumulative rather than incremental, because
   * that is what the harness receives -- measured: the same announcement arrives three
   * times as a command keeps writing. An announcement already sent is not sent again.
   */
  fromOutput: (output: string) => readonly Event[]
  /**
   * Closes what the turn left open. A script that announced `running` and then died leaves
   * a spinner on a person's screen, and nothing downstream can know that: from the stream's
   * point of view the turn simply ended.
   */
  settle: () => readonly Event[]
}

export const createProjection = (): Projection => {
  const sent = new Map<string, Announcement>()

  const fromOutput = (output: string): readonly Event[] => {
    const events: Event[] = []
    for (const line of output.split('\n')) {
      const event = project(readAnnouncement(line))
      if (event !== null) events.push(event)
    }
    return events
  }

  const project = (announcement: Announcement | null): Event | null => {
    if (announcement === null) return null
    if (unchanged(sent.get(announcement.id), announcement)) return null

    sent.set(announcement.id, announcement)
    return snapshot(announcement)
  }

  const settle = (): readonly Event[] => {
    const abandoned = [...sent.values()].map(giveUp).filter(isPresent).map(snapshot)
    sent.clear()
    return abandoned
  }

  return { fromOutput, settle }
}

const unchanged = (previous: Announcement | undefined, next: Announcement): boolean =>
  previous !== undefined && JSON.stringify(previous.content) === JSON.stringify(next.content)

/** Null for anything that had already settled, which is most of what a turn leaves behind. */
const giveUp = (announcement: Announcement): Announcement | null => {
  if (announcement.activityType !== STEP) return null
  if (announcement.content.state !== 'running') return null

  // The label is kept: it is the only thing a person can use to tell which step stopped.
  // No detail is added -- we do not know why it stopped, and inventing one is worse.
  return { ...announcement, content: { ...announcement.content, state: 'failed' } }
}

const isPresent = <T>(value: T | null): value is T => value !== null

const snapshot = (announcement: Announcement): Event => ({
  type: EventType.ACTIVITY_SNAPSHOT,
  messageId: announcement.id,
  activityType: announcement.activityType,
  content: announcement.content,
})
