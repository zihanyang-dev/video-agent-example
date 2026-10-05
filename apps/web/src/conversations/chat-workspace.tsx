import { useState } from 'react'
import { ChatAssets } from '../assets/chat-assets'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { PublicThread } from '@vid/contract/http'
import { errorMessage } from '../http'
import { threadQuery, messagesQuery, type ThreadScope } from './queries'
import { Transcript } from './transcript'
import { Composer } from './composer'
import { ChatSettings } from './chat-settings'
import { RunPanel } from './run-panel'
import { useMessageSubmission } from './use-message-submission'

export function ChatWorkspace({ scope }: { scope: ThreadScope }) {
  const client = useQueryClient()
  const thread = useQuery(threadQuery(scope))
  const refresh = () => {
    void client.invalidateQueries({
      queryKey: ['user', scope.userID, scope.threadID],
    })
  }
  if (thread.isError)
    return (
      <section>
        <p role="alert">{errorMessage(thread.error)}</p>
        <button onClick={refresh}>Refresh Chat</button>
      </section>
    )
  if (!thread.data) return <p role="status">Loading Chat…</p>
  const isArchived = thread.data.thread.archivedAt !== null
  return (
    <section>
      <header>
        <h1>{thread.data.thread.title}</h1>
        <button onClick={refresh}>Refresh Chat</button>
      </header>
      {isArchived ? (
        <p role="status">
          Archived — read only. Accepted runs may still be stopping.
        </p>
      ) : (
        <ChatSettings scope={scope} title={thread.data.thread.title} />
      )}
      <ChatMessages scope={scope} thread={thread.data.thread} />
    </section>
  )
}

function ChatMessages({
  scope,
  thread,
}: {
  scope: ThreadScope
  thread: PublicThread
}) {
  const snapshot = useQuery(messagesQuery(scope))
  const submission = useMessageSubmission(scope)
  const [selected, setSelected] = useState<string[]>([])
  if (snapshot.isPending)
    return <p role="status">Loading messages and active runs…</p>
  if (snapshot.isError)
    return <p role="alert">{errorMessage(snapshot.error)}</p>
  const { messages, activeRuns, failedRuns } = snapshot.data
  const canSend =
    activeRuns.length === 0 && !submission.hasPending && !submission.isBusy
  return (
    <>
      <Transcript messages={messages} failedRuns={failedRuns} />
      <ChatAssets
        key={thread.archivedAt ?? 'active'}
        scope={scope}
        canSelect={canSend}
        selected={selected}
        select={setSelected}
        archived={thread.archivedAt !== null}
      />
      {activeRuns.map((run) => (
        <RunPanel
          key={run.runID}
          scope={scope}
          run={run}
          persisted={messages}
          isArchived={thread.archivedAt !== null}
        />
      ))}
      {thread.archivedAt === null && (
        <Composer
          canSend={canSend}
          isBusy={submission.isBusy}
          hasPending={submission.hasPending}
          hasAssets={selected.length > 0}
          send={async (text) => {
            await submission.send(text, selected)
            setSelected([])
          }}
          retry={submission.retry}
        />
      )}
      {submission.error && <p role="alert">{submission.error}</p>}
    </>
  )
}
