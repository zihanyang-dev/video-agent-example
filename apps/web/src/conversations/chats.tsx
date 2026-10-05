import { useRef, useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { type PublicThread } from '@vid/contract/http'
import { errorMessage, apiForUser } from '../http'
import { createThread } from '@vid/contract/client'
import { ChatCreation, type ChatCreationIntent } from './chat-creation'
import { threadsQuery } from './queries'
import { ChatWorkspace } from './chat-workspace'

function readSelection() {
  return new URL(window.location.href).searchParams.get('thread') ?? ''
}

export function Chats({ userID }: { userID: string }) {
  const isMounted = useRef(true)
  useEffect(() => {
    isMounted.current = true
    return () => {
      isMounted.current = false
    }
  }, [])
  const client = useQueryClient()
  const [threadID, setThreadID] = useState(readSelection)
  useEffect(() => {
    const followHistory = () => setThreadID(readSelection())
    window.addEventListener('popstate', followHistory)
    return () => window.removeEventListener('popstate', followHistory)
  }, [])
  const select = (selectedID: string) => {
    const url = new URL(window.location.href)
    url.searchParams.set('thread', selectedID)
    window.history.pushState(null, '', url)
    setThreadID(selectedID)
  }
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ['user', userID] })
  }
  const createChat = async (intent: ChatCreationIntent) => {
    const { data: receipt } = await createThread({
      client: apiForUser(userID),
      body: intent,
      throwOnError: true,
    })
    if (!isMounted.current) return
    select(receipt.thread.threadID)
    await client.invalidateQueries(threadsQuery(userID))
  }
  return (
    <div className="workspace">
      <ChatNavigation
        userID={userID}
        threadID={threadID}
        select={select}
        refresh={refresh}
        createChat={createChat}
      />
      <main>
        {threadID ? (
          <ChatWorkspace
            key={`${userID}:${threadID}`}
            scope={{ userID, threadID }}
          />
        ) : (
          <h1>Select or create a Chat.</h1>
        )}
      </main>
    </div>
  )
}

function ChatLink({
  thread,
  selected,
  select,
}: {
  thread: PublicThread
  selected: string
  select: (threadID: string) => void
}) {
  const choose = () => select(thread.threadID)
  return (
    <button
      className="thread"
      aria-current={selected === thread.threadID}
      onClick={choose}
    >
      {thread.title}
      {thread.archivedAt ? ' (archived)' : ''}
    </button>
  )
}

function ChatNavigation({
  userID,
  threadID,
  select,
  refresh,
  createChat,
}: {
  userID: string
  threadID: string
  select: (threadID: string) => void
  refresh: () => void
  createChat: (creation: ChatCreationIntent) => Promise<void>
}) {
  const threads = useQuery(threadsQuery(userID))
  return (
    <aside>
      <a className="brand" href="/">
        ◩ Frame
      </a>
      <h2>Chats</h2>
      <button onClick={refresh}>Refresh Chats</button>
      {threads.isPending && <p role="status">Loading Chats…</p>}
      {threads.isError && <p role="alert">{errorMessage(threads.error)}</p>}
      <nav aria-label="Chats">
        {threads.data?.threads.map((thread) => (
          <ChatLink
            key={thread.threadID}
            thread={thread}
            selected={threadID}
            select={select}
          />
        ))}
      </nav>
      <ChatCreation userID={userID} create={createChat} />
    </aside>
  )
}
