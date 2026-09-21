/**
 * Wires the stream to the rule and hands React the result.
 *
 * A boundary: it owns no rule about what a person sees -- that is `transcript.ts` -- and no
 * knowledge of how events arrive -- that is `stream.ts`. What is here is the part that is
 * genuinely about React: when to subscribe, when to stop, and what a component re-renders on.
 */
import type { Event } from '@ag-ui/core'
import { useCallback, useEffect, useState } from 'react'
import { listen, say, stopWork } from './stream'
import { advance, asked, nothingYet, type Transcript } from './transcript'

export type Conversation = {
  transcript: Transcript
  /** True from the moment someone presses send, not from the moment the turn starts. */
  working: boolean
  /** False while the connection is down. `EventSource` is already retrying. */
  connected: boolean
  send: (message: string) => Promise<void>
  /** Asks the running turn to stop. Safe to call when nothing is running. */
  stop: () => Promise<void>
}

export const useConversation = (threadID: string | null): Conversation => {
  const [transcript, setTranscript] = useState<Transcript>(nothingYet)
  const [connected, setConnected] = useState(false)

  // A turn takes a moment to be picked up, and until its RUN_STARTED arrives the transcript
  // would say nothing is happening. Someone who pressed send and saw nothing change presses
  // send again.
  const [queued, setQueued] = useState(false)

  useEffect(() => {
    if (threadID === null) return

    setTranscript(nothingYet)
    const conversation = listen(
      threadID,
      (event: Event) => {
        if (event.type === 'RUN_STARTED') setQueued(false)
        setTranscript((current) => advance(current, event))
      },
      setConnected,
    )

    return () => conversation.close()
  }, [threadID])

  const send = useCallback(
    async (message: string): Promise<void> => {
      if (threadID === null) return

      setQueued(true)
      setTranscript((current) => asked(current, `asking:${crypto.randomUUID()}`, message))

      try {
        await say(threadID, message)
      } catch (error) {
        setQueued(false)
        throw error
      }
    },
    [threadID],
  )

  const stop = useCallback(async (): Promise<void> => {
    if (threadID === null) return

    // Cleared here rather than waiting for RUN_FINISHED: if the turn had not started yet
    // there is nothing to end, and the button would stay on with nothing behind it.
    setQueued(false)
    await stopWork(threadID)
  }, [threadID])

  return { transcript, working: transcript.working || queued, connected, send, stop }
}
