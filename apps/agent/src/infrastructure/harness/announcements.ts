import { z } from 'zod'
import type { Observation } from '../../domain/progress'

const Plan = z.object({
  activityType: z.literal('plan'),
  content: z.object({
    items: z
      .array(
        z.object({ label: z.string().min(1), state: z.enum(['todo', 'doing', 'done', 'skipped']) }),
      )
      .min(1),
  }),
})

const Step = z.object({
  activityType: z.literal('step'),
  content: z.object({
    label: z.string().min(1),
    state: z.enum(['running', 'done', 'failed']),
    detail: z.string().optional(),
  }),
})

const Artifact = z.object({
  activityType: z.literal('artifact'),
  content: z.object({ url: z.string().min(1), role: z.enum(['preview', 'final']) }),
})

const Ask = z.object({
  activityType: z.literal('ask'),
  content: z.object({
    question: z.string().min(1),
    options: z.array(z.string()),
    answer: z.string().nullable(),
  }),
})

const Announcement = z.intersection(
  z.object({ id: z.string().min(1) }),
  z.discriminatedUnion('activityType', [Plan, Step, Artifact, Ask]),
)

type Announcement = z.infer<typeof Announcement>

export const ANNOUNCE_PREFIX = '::vid '

export const readAnnouncement = (line: string): Announcement | null => {
  if (!line.startsWith(ANNOUNCE_PREFIX)) return null

  const parsed = Announcement.safeParse(parseJson(line.slice(ANNOUNCE_PREFIX.length)))
  return parsed.success ? parsed.data : null
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    // Unstructured tool output is not a progress announcement.
    return null
  }
}

/**
 * Tool updates contain accumulated output, so each announcement is compared with its
 * last accepted snapshot. Reusing an ID with changed content replaces that activity;
 * repeating unchanged output must not create another progress event.
 */
export const createAnnouncements = () => {
  const announcedByID = new Map<string, Announcement>()

  return {
    fromOutput: (output: string): Observation[] => {
      const observations: Observation[] = []

      for (const line of output.split('\n')) {
        const announced = readAnnouncement(line)
        if (
          !announced ||
          JSON.stringify(announcedByID.get(announced.id)) === JSON.stringify(announced)
        )
          continue

        announcedByID.set(announced.id, announced)
        observations.push(observationOf(announced))
      }

      return observations
    },

    settle: (): Observation[] => {
      const observations: Observation[] = [...announcedByID.values()].flatMap((announced) =>
        announced.activityType === 'step' && announced.content.state === 'running'
          ? [{ kind: 'step', messageID: announced.id, ...announced.content, state: 'failed' }]
          : [],
      )
      announcedByID.clear()

      return observations
    },
  }
}

const observationOf = (announced: Announcement): Observation => {
  if (announced.activityType === 'artifact') {
    // The script protocol calls this a URL; bytes are still local until workspace publication.
    return {
      kind: 'artifact',
      messageID: announced.id,
      path: announced.content.url,
      role: announced.content.role,
    }
  }

  if (announced.activityType === 'plan')
    return { kind: 'plan', messageID: announced.id, ...announced.content }
  if (announced.activityType === 'step')
    return { kind: 'step', messageID: announced.id, ...announced.content }
  return { kind: 'ask', messageID: announced.id, ...announced.content }
}
