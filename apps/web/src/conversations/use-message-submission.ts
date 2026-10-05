import { useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { messageSubmissionSchema } from '@vid/contract/http'
import { errorMessage, HTTPError, apiForUser } from '../http'
import { submitMessage } from '@vid/contract/client'
import { pendingIntents, pendingIntentRecoveryMessage } from './pending-intents'
import { messagesQuery, type ThreadScope } from './queries'

type PendingMessage = ReturnType<typeof messageSubmissionSchema.parse>

export function useMessageSubmission(scope: ThreadScope) {
  const isMounted = useRef(true)
  useEffect(() => {
    isMounted.current = true
    return () => {
      isMounted.current = false
    }
  }, [])
  const client = useQueryClient()
  const intents = pendingIntents(scope.userID)
  const [restored] = useState(() => {
    try {
      return { pending: intents.readMessage(scope.threadID), error: '' }
    } catch {
      return { pending: undefined, error: pendingIntentRecoveryMessage }
    }
  })
  const [pending, setPending] = useState(restored.pending)
  const mutation = useMutation({
    meta: { userID: scope.userID },
    mutationFn: async (message: PendingMessage) => {
      await submitMessage({
        client: apiForUser(scope.userID),
        path: { threadID: scope.threadID },
        body: message,
        throwOnError: true,
      })
    },
    onSuccess: async () => {
      if (!isMounted.current) return
      // Do not synthesize persisted messages from a receipt. In particular, exact
      // replay can return older business IDs. Only the server snapshot owns facts.
      intents.acceptMessage(scope.threadID)
      setPending(undefined)
      await client.invalidateQueries(messagesQuery(scope))
    },
  })
  const submit = async (input?: { text: string; assetIDs: string[] }) => {
    if (mutation.isPending) return
    if (restored.error) throw new Error(restored.error)
    const frozen = input
      ? intents.message(scope.threadID, input)
      : intents.readMessage(scope.threadID)
    if (!frozen) return
    setPending(frozen)
    await mutation.mutateAsync(frozen)
  }
  const send = (text: string, assetIDs: string[] = []) =>
    submit({ text, assetIDs })
  const retry = () => submit()
  const error =
    restored.error || (mutation.isError ? submissionError(mutation.error) : '')
  return {
    send,
    retry,
    hasPending: !!pending || !!restored.error,
    isBusy: mutation.isPending,
    error,
  }
}

function submissionError(error: Error) {
  if (error instanceof HTTPError && [401, 403, 404, 409].includes(error.status))
    return errorMessage(error)
  return 'Message acceptance is unknown. Retry the same message; do not send a replacement.'
}
