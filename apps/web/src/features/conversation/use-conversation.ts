import type { Event } from '@ag-ui/core'
import { useCallback, useEffect, useState } from 'react'
import { listen, say, stopWork } from './stream'
import { advance, asked, nothingYet, type Transcript } from './transcript'

export type Conversation = {
  transcript: Transcript
  working: boolean
  connected: boolean
  send: (message: string) => Promise<void>
  stop: () => Promise<void>
}

export const useConversation = (threadID: string | null): Conversation => {
  const [transcript, setTranscript] = useState<Transcript>(nothingYet)
  const [connected, setConnected] = useState(false)

  // Keep submitted input visibly pending until the server publishes a turn lifecycle event.
  const [queued, setQueued] = useState(false)

  useEffect(() => {
    if (threadID === null) return

    setTranscript(nothingYet)
    const conversation = listen(
      threadID,
      (event: Event) => {
        if (
          event.type === 'RUN_STARTED' ||
          event.type === 'RUN_FINISHED' ||
          event.type === 'RUN_ERROR'
        ) {
          setQueued(false)
        }

        setTranscript((current) => advance(current, event))
      },
      setConnected,
    )

    return () => conversation.close()
  }, [threadID])

  const send = useCallback(
    async (message: string): Promise<void> => {
      if (threadID === null) return

      // The server derives the same message ID, so its echo replaces this optimistic row.
      const commandID = crypto.randomUUID()
      setQueued(!transcript.working)
      setTranscript((current) => asked(current, `${commandID}:asked`, message))

      try {
        await say(threadID, { commandID, message })
      } catch (error) {
        setQueued(false)
        throw error
      }
    },
    [threadID, transcript.working],
  )

  const stop = useCallback(async (): Promise<void> => {
    if (threadID === null) return

    // Stop targets a projected active turn. This only clears the local waiting indicator;
    // it does not cancel input that the server has queued for a future turn.
    setQueued(false)
    await stopWork(threadID)
  }, [threadID])

  return { transcript, working: transcript.working || queued, connected, send, stop }
}
