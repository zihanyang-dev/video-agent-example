/**
 * The page.
 *
 * The thread id lives in the URL fragment so a reload, a bookmark or a pasted link all land
 * back in the same conversation. It is not in the path because there is no router here and
 * one conversation does not need one.
 */
import { useEffect, useState } from 'react'
import { Composer } from './features/conversation/composer'
import { Conversation } from './features/conversation/conversation'
import { Stage } from './features/conversation/stage'
import { openConversation } from './features/conversation/stream'
import { useConversation } from './features/conversation/use-conversation'

export const App = () => {
  const [threadID, setThreadID] = useState<string | null>(null)
  const [unreachable, setUnreachable] = useState<string | null>(null)
  const { transcript, working, connected, send, stop } = useConversation(threadID)

  useEffect(() => {
    // Also on every hash change, not only on mount: the back button and a pasted link both
    // change the fragment without reloading, and a page that ignored that would keep
    // showing the previous conversation under the new address.
    const follow = () => {
      const existing = window.location.hash.slice(1)
      if (existing !== '') {
        setUnreachable(null)
        setThreadID(existing)
        return
      }

      void openConversation()
        .then((opened) => {
          window.location.hash = opened
          setThreadID(opened)
        })
        .catch((error: unknown) => {
          setUnreachable(error instanceof Error ? error.message : 'the server is not answering')
        })
    }

    follow()
    window.addEventListener('hashchange', follow)
    return () => window.removeEventListener('hashchange', follow)
  }, [])

  return (
    <main>
      <Stage transcript={transcript} working={working} />

      <aside>
        <header>
          <h1>Cut</h1>
          <Status
            working={working}
            // Only complain about the connection once there is a conversation to connect to.
            connected={connected || threadID === null}
          />
        </header>

        {unreachable === null ? (
          <Conversation transcript={transcript} />
        ) : (
          <p className="broke">{unreachable}</p>
        )}

        <Composer onSend={send} onStop={stop} working={working} />
      </aside>
    </main>
  )
}

const Status = ({ working, connected }: { working: boolean; connected: boolean }) => {
  if (!connected) return <span className="status away">Reconnecting</span>
  if (working) return <span className="status busy">Working</span>
  return <span className="status idle">Ready</span>
}
