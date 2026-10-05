import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ActiveRun, PublicMessage } from '@vid/contract/http'
import { errorMessage, apiForUser } from '../http'
import { cancelRun } from '@vid/contract/client'
import { pendingIntents } from './pending-intents'
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
  const intents = pendingIntents(scope.userID)
  const cancel = useMutation({
    meta: { userID: scope.userID },
    mutationFn: async () => {
      await cancelRun({
        client: apiForUser(scope.userID),
        path: { threadID: scope.threadID, runID: run.runID },
        body: intents.cancellation({
          threadID: scope.threadID,
          runID: run.runID,
        }),
        throwOnError: true,
      })
    },
  })
  const requestCancellation = () =>
    cancel.mutate(undefined, {
      onSuccess: () => {
        void client.invalidateQueries(messagesQuery(scope))
      },
    })
  if (run.status === 'stopping')
    return <p role="status">Waiting for actual stop…</p>
  return (
    <div>
      <button
        disabled={cancel.isPending || cancel.isSuccess}
        onClick={requestCancellation}
      >
        {cancel.isError ? 'Retry cancellation' : 'Cancel run'}
      </button>
      {cancel.isSuccess && (
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
