import { useEffect, useRef, useState } from 'react'
import { HttpAgent } from '@ag-ui/client'
import { useQueryClient } from '@tanstack/react-query'
import { HTTPError, errorMessage } from '../http'
import { messagesQuery, type ThreadScope } from './queries'
import { runEventsURL } from './run-endpoint'
import { emptyRunView, reduceRunEvent } from './run-view'

export function useObservation(
  scope: ThreadScope,
  runID: string,
  isEnabled = true,
) {
  const client = useQueryClient()
  const view = useRef(emptyRunView())
  const [overlay, setOverlay] = useState(view.current)
  const [status, setStatus] = useState('Connecting…')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!isEnabled) {
      setStatus('Archived — observation disconnected.')
      return
    }
    let isCurrent = true
    let agent: HttpAgent | undefined
    const controller = new AbortController()
    const refreshSnapshot = async () => {
      await client.invalidateQueries(messagesQuery(scope))
    }
    const observe = async () => {
      try {
        const url = await runEventsURL({ threadID: scope.threadID, runID })
        if (!isCurrent) return
        agent = new HttpAgent({
          url,
          threadId: scope.threadID,
          fetch: (url, init) =>
            authenticatedStream(url, {
              ...init,
              signal: AbortSignal.any([
                controller.signal,
                ...(init?.signal ? [init.signal] : []),
              ]),
            }),
        })
        setStatus('Observing accepted run…')
        await agent.runAgent(
          { runId: runID, forwardedProps: { after: view.current.after } },
          {
            onEvent({ event }) {
              if (!isCurrent) return
              view.current = reduceRunEvent(view.current, event)
              setOverlay(view.current)
            },
          },
        )
        if (!isCurrent) return
        setStatus(
          view.current.terminal
            ? 'Run settled. Refreshing authoritative messages…'
            : 'Observation disconnected. Reconnect without resubmitting.',
        )
        await refreshSnapshot()
      } catch (error) {
        if (!isCurrent) return
        setStatus(errorMessage(error))
        if (error instanceof HTTPError && error.status === 401)
          client.setQueryData(['session'], { user: null })
      }
    }
    void observe()
    // Aborting observation closes this browser reader only. Execution cancellation
    // is a separate server command, never an unmount or network side effect.
    return () => {
      isCurrent = false
      controller.abort()
      agent?.abortRun()
    }
  }, [client, scope.userID, scope.threadID, runID, attempt, isEnabled])
  const reconnect = () => setAttempt((previous) => previous + 1)
  return { overlay, status, reconnect }
}

async function authenticatedStream(url: string, init?: RequestInit) {
  let response: Response
  try {
    response = await fetch(url, { ...init, credentials: 'same-origin' })
  } catch {
    throw new HTTPError(0)
  }
  if (!response.ok) throw new HTTPError(response.status)
  return response
}
