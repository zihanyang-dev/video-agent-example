import { useMutation, useQueryClient } from '@tanstack/react-query'
import type {
  ActiveRun,
  PublicMessage,
  runCancellationSchema,
} from '@vid/contract/http'
import { errorMessage, apiForUser } from '../http'
import { cancelRun } from '@vid/contract/client'
import { pendingIntents, pendingIntentRecoveryMessage } from './pending-intents'
import { messagesQuery, type ThreadScope } from './queries'
import { useObservation } from './use-observation'
import { Transcript } from './transcript'
import { pendingTranscript } from './run-view'

export function RunPanel({
  scope,
  run,
  persisted,
  isArchived = false,
}: {
  scope: ThreadScope
  run: ActiveRun
  persisted: readonly PublicMessage[]
  isArchived?: boolean
}) {
  const observer = useObservation(scope, run.runID, !isArchived)
  const drafts = pendingTranscript(persisted, observer.overlay)
  return (
    <section aria-label="Current run">
      <div className="run-panel">
        <div>
          <p role="status">
            Run {run.status}. {observer.status}
          </p>
          <p className="detail">Run {run.runID}</p>
        </div>
        <div className="actions">
          <button onClick={observer.reconnect} disabled={isArchived}>
            Reconnect observation
          </button>
          {!isArchived && !observer.overlay.terminal && (
            <CancelRun scope={scope} run={run} />
          )}
        </div>
      </div>
      {observer.overlay.error && <p role="alert">{observer.overlay.error}</p>}
      {drafts.length > 0 && (
        <>
          <p className="detail">
            Temporary streamed response — awaiting server snapshot.
          </p>
          <Transcript messages={drafts} />
        </>
      )}
    </section>
  )
}

function CancelRun({ scope, run }: { scope: ThreadScope; run: ActiveRun }) {
  const client = useQueryClient()
  const cancel = useMutation({
    meta: { userID: scope.userID },
    mutationFn: () => requestRunCancellation(scope, run.runID),
  })
  const requestCancellation = () =>
    cancel.mutate(undefined, {
      onSuccess: (receipt) => {
        if (receipt.storageError) return
        void client.invalidateQueries(messagesQuery(scope))
      },
    })
  const storageError = cancel.data?.storageError ?? ''
  const isAccepted = cancel.isSuccess && !storageError
  if (run.status === 'stopping')
    return <p role="status">Waiting for actual stop…</p>
  return (
    <div>
      <button
        disabled={cancel.isPending || isAccepted}
        onClick={requestCancellation}
      >
        {cancel.isError ? 'Retry cancellation' : 'Cancel run'}
      </button>
      {storageError && <p role="alert">{storageError}</p>}
      {isAccepted && (
        <p role="status">Cancellation accepted. Waiting for actual stop…</p>
      )}
      {cancel.isError && (
        <p role="alert">
          {errorMessage(cancel.error)} Retry keeps the same cancellation ID.
        </p>
      )}
    </div>
  )
}

export async function requestRunCancellation(
  scope: ThreadScope,
  runID: string,
) {
  let frozen: ReturnType<typeof runCancellationSchema.parse>
  try {
    frozen = pendingIntents(scope.userID).cancellation({
      threadID: scope.threadID,
      runID,
    })
  } catch (error) {
    // Only this local persistence boundary may recognize its owned recovery
    // message. HTTP and arbitrary errors still use private-safe formatting.
    return {
      storageError:
        error instanceof Error && error.message === pendingIntentRecoveryMessage
          ? pendingIntentRecoveryMessage
          : 'Cancellation could not be saved in this browser. Free browser storage before retrying.',
    }
  }
  await cancelRun({
    client: apiForUser(scope.userID),
    path: { threadID: scope.threadID, runID },
    body: frozen,
    throwOnError: true,
  })
  return { storageError: '' }
}
