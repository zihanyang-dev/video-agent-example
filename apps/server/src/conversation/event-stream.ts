import { EventType, type Event } from '@ag-ui/core'
import { EventEncoder } from '@ag-ui/encoder'
import type { DB } from '@vid/database/types'
import type { Kysely } from 'kysely'
import { readPublicEvents } from '../db/execution-events'
import { mapPublicRunEvent, type PublicRunState } from './public-run-events'

export type EventSubscription = Readonly<{ close: () => Promise<void> }>
export type RegisterSubscription = (
  subscription: EventSubscription,
) => () => void

type Observation = Readonly<{
  ownerID: string
  threadID: string
  runID: string
  after: string
  pollMs: number
  requestSignal: AbortSignal
  processSignal: AbortSignal
  registerSubscription?: RegisterSubscription
  authorize: () => Promise<boolean>
}>
type Fact = NonNullable<Awaited<ReturnType<typeof readPublicEvents>>>[number]

export async function observeEvents(
  db: Kysely<DB>,
  query: Observation,
): Promise<Response> {
  const subscription = new PublicEventSubscription(db, query)
  return await subscription.open()
}

// A Response settles before its asynchronous pulls do. This instance owns both
// the stream and outstanding DB work, and is registered before reconstruction.
class PublicEventSubscription {
  private events: PublicRunState = {
    started: false,
    terminal: false,
    messages: new Map(),
  }
  private readonly abort = new AbortController()
  private readonly encoder = new EventEncoder({ accept: 'text/event-stream' })
  private controller: ReadableStreamDefaultController<Uint8Array> | undefined
  private pending: Promise<unknown> = Promise.resolve()
  private closed = false
  private unregister: (() => void) | undefined
  private cursor: string
  private readonly openedMessages = new Set<string>()
  private initialFrames: Event[] = []
  private readonly utf8 = new TextEncoder()

  constructor(
    private readonly db: Kysely<DB>,
    private readonly query: Observation,
  ) {
    this.cursor = query.after
  }

  async open(): Promise<Response> {
    this.unregister = this.query.registerSubscription?.(this)
    this.query.requestSignal.addEventListener('abort', this.stop, {
      once: true,
    })
    this.query.processSignal.addEventListener('abort', this.stop, {
      once: true,
    })
    const rebuilding = this.reconstructObservation()
    this.pending = rebuilding
    try {
      await rebuilding
    } catch (cause) {
      await this.close()
      throw cause
    }
    const stream = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          this.controller = controller
          if (
            this.closed ||
            this.query.requestSignal.aborted ||
            this.query.processSignal.aborted
          )
            this.stop()
        },
        pull: (controller) => {
          const pending = this.readNext(controller)
          this.pending = pending
          return pending
        },
        cancel: () => {
          // The reader already closed its controller; only settle owned work.
          this.controller = undefined
          return this.close()
        },
      },
      { highWaterMark: 0 },
    )
    return new Response(stream, {
      headers: {
        'Content-Type': this.encoder.getContentType(),
        'Cache-Control': 'no-cache, no-transform',
      },
    })
  }

  private async reconstructObservation() {
    const rebuilt = await reconstruct(this.db, this.query, this.events)
    this.events = { ...rebuilt.state, started: true }
    this.initialFrames = [
      {
        type: EventType.RUN_STARTED,
        threadId: this.query.threadID,
        runId: this.query.runID,
        metadata: { eventID: `${this.query.runID}:observation-start` },
      },
    ]
    if (rebuilt.terminalFact) {
      // A caller's cursor is not a new fact. Even terminal reconnects publish
      // the durable terminal's actual cursor, never the requested offset.
      this.cursor = rebuilt.terminalFact.cursor
      this.initialFrames.push(
        ...mapPublicRunEvent(this.events, rebuilt.terminalFact.event).frames,
      )
    }
  }

  close = async (): Promise<void> => {
    this.stop()
    // Abort prevents further reads, but cannot cancel an already issued query.
    // Waiting the actual promise, rather than racing abort, keeps DB ownership.
    await this.pending.catch(() => {
      // Read failures have already been reported by open/readNext. Closing owns
      // settlement, not a second diagnostic or a replacement recovery outcome.
    })
    this.unregister?.()
    this.unregister = undefined
  }

  private stop = () => {
    if (!this.closed) {
      this.closed = true
      this.abort.abort()
      this.query.requestSignal.removeEventListener('abort', this.stop)
      this.query.processSignal.removeEventListener('abort', this.stop)
    }
    this.controller?.close()
    this.controller = undefined
    void this.pending.then(this.releaseIfClosed, this.releaseIfClosed)
  }

  private releaseIfClosed = () => {
    if (!this.closed) return
    this.unregister?.()
    this.unregister = undefined
  }

  private async readNext(
    controller: ReadableStreamDefaultController<Uint8Array>,
  ) {
    try {
      const chunk = await this.readNextFact()
      if (this.closed) return
      if (chunk) controller.enqueue(chunk)
      if (!chunk || this.events.terminal) this.stop()
    } catch (cause) {
      if (this.closed) return
      // Keep diagnostics classified: the query's private parameters and driver
      // error text are not public stream prose or log fields.
      console.error('Public event read failed', {
        classification: 'database-read',
        cause: cause instanceof Error ? cause.name : typeof cause,
      })
      controller.error(
        new Error('Event stream unavailable. Reconnect to try again.'),
      )
      this.controller = undefined
      this.stop()
    }
  }

  /** Reconstructed text determines suffixes, not the new client's lifecycle.
   * Every observation opens a message before content/end, including reconnect. */
  private lifecycleFrames(frames: Event[]): Event[] {
    const ordered: Event[] = []
    for (const frame of frames) {
      if (frame.type === EventType.TEXT_MESSAGE_START)
        this.openedMessages.add(frame.messageId)
      if (
        (frame.type === EventType.TEXT_MESSAGE_CONTENT ||
          frame.type === EventType.TEXT_MESSAGE_END) &&
        !this.openedMessages.has(frame.messageId)
      ) {
        this.openedMessages.add(frame.messageId)
        ordered.push({
          type: EventType.TEXT_MESSAGE_START,
          messageId: frame.messageId,
          role: 'assistant',
          metadata: {
            eventID: `${this.query.runID}:${frame.messageId}:observation-start`,
          },
        })
      }
      ordered.push(frame)
    }
    return ordered
  }

  private async readInitialFrames(): Promise<Uint8Array | null> {
    if (!(await this.query.authorize())) return null
    const frames = this.lifecycleFrames(this.initialFrames)
    this.initialFrames = []
    const encoded = this.events.terminal
      ? encodeFact(this.cursor, frames, this.encoder)
      : frames.map((frame) => this.encoder.encodeSSE(frame)).join('')
    return this.utf8.encode(encoded)
  }

  private async readNextFact(): Promise<Uint8Array | null> {
    if (this.initialFrames.length) return await this.readInitialFrames()
    while (!this.abort.signal.aborted && !this.events.terminal) {
      if (!(await this.query.authorize())) return null
      const facts = await readPublicEvents(this.db, {
        ownerID: this.query.ownerID,
        threadID: this.query.threadID,
        after: this.cursor,
        limit: 1,
      })
      if (this.abort.signal.aborted || facts === null) return null
      if (!(await this.query.authorize())) return null
      const fact = facts[0]
      if (!fact) {
        await waitForPoll(this.query.pollMs, this.abort.signal)
        continue
      }
      this.cursor = fact.cursor
      if (fact.event.runID !== this.query.runID) continue
      const mapped = mapPublicRunEvent(this.events, fact.event)
      this.events = mapped.state
      return this.utf8.encode(
        encodeFact(
          fact.cursor,
          this.lifecycleFrames(mapped.frames),
          this.encoder,
        ),
      )
    }
    return null
  }
}

type ReplayState = Readonly<{
  state: PublicRunState
  cursor: string
  terminalFact: Fact | undefined
}>

async function reconstruct(
  db: Kysely<DB>,
  query: Observation,
  state: PublicRunState,
) {
  let replay: ReplayState = { state, cursor: '0', terminalFact: undefined }
  const boundary = BigInt(query.after)
  while (BigInt(replay.cursor) < boundary) {
    if (query.requestSignal.aborted || query.processSignal.aborted)
      return replay
    if (!(await query.authorize())) return replay
    const facts = await readPublicEvents(db, {
      ownerID: query.ownerID,
      threadID: query.threadID,
      after: replay.cursor,
      limit: 100,
    })
    if (query.requestSignal.aborted || query.processSignal.aborted)
      return replay
    if (!(await query.authorize())) return replay
    if (!facts?.length) return replay
    replay = foldReplayBatch(facts, query.runID, boundary, replay)
  }
  return replay
}

function foldReplayBatch(
  facts: readonly Fact[],
  runID: string,
  boundary: bigint,
  prior: ReplayState,
): ReplayState {
  let { state, cursor, terminalFact } = prior
  for (const fact of facts) {
    // Scanning can cross the requested cursor, but later facts cannot change
    // reconstructed state. The outer reader stops at this scanned boundary.
    cursor = fact.cursor
    if (BigInt(cursor) > boundary) break
    if (fact.event.runID !== runID) continue
    state = mapPublicRunEvent(state, fact.event).state
    if (
      fact.event.kind === 'run-completed' ||
      fact.event.kind === 'run-cancelled' ||
      fact.event.kind === 'run-failed'
    )
      terminalFact ??= fact
  }
  return { state, cursor, terminalFact }
}

function encodeFact(cursor: string, frames: Event[], encoder: EventEncoder) {
  // Only the final frame advances the cursor: a mid-fact disconnect replays
  // all frames with stable identities instead of silently dropping the suffix.
  let encoded = ''
  for (const frame of frames.slice(0, -1)) encoded += encoder.encodeSSE(frame)
  const final = frames.at(-1)
  if (final)
    encoded += `${encoder.encodeSSE({ ...final, metadata: { ...final.metadata, cursor } }).trimEnd()}\nid: ${cursor}\n\n`
  return encoded
}

function waitForPoll(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const finish = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    signal.addEventListener('abort', finish, { once: true })
  })
}
