import { ChatAssets } from '../assets/chat-assets'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { PublicThread } from '@vid/contract/http'
import { errorMessage } from '../http'
import { threadQuery, messagesQuery, type ThreadScope } from './queries'
import { Transcript } from './transcript'
import { Composer } from './composer'
import { ChatSettings } from './chat-settings'
import { RunPanel } from './run-panel'

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
  if (snapshot.isPending)
    return <p role="status">Loading messages and active runs…</p>
  if (snapshot.isError)
    return <p role="alert">{errorMessage(snapshot.error)}</p>
  const { messages, activeRuns, failedRuns } = snapshot.data
  return (
    <>
      <Transcript messages={messages} failedRuns={failedRuns} />
      {thread.archivedAt !== null && (
        <ChatAssets
          scope={scope}
          canSelect={false}
          selected={[]}
          select={() => {}}
          archived
        />
      )}
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
        <Composer scope={scope} canSend={activeRuns.length === 0} />
      )}
    </>
  )
}
