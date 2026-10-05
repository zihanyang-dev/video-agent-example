import { useEffect, useRef, useState } from 'react'
import { createAuthClient } from 'better-auth/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { sessionResponseSchema } from '@vid/contract/http'
import { errorMessage } from '../http'
import { Chats } from '../conversations/chats'

import {
  sessionQuery,
  forgetAccountFacts,
  revokeAccountSession,
} from './session-cache'
export { sessionQuery, createWebQueryClient } from './session-cache'

const auth = createAuthClient({ basePath: '/api/auth' })

export function Identity() {
  const session = useQuery(sessionQuery)
  if (session.isError)
    return (
      <main>
        <p role="alert">{errorMessage(session.error)}</p>
        <RetrySession />
      </main>
    )
  if (!session.data)
    return (
      <main>
        <p role="status">Checking your session…</p>
      </main>
    )
  if (!session.data.user) return <SignedOut />
  return <SignedIn key={session.data.user.userID} user={session.data.user} />
}

function RetrySession() {
  const client = useQueryClient()
  const retry = () => {
    void client.invalidateQueries(sessionQuery)
  }
  return <button onClick={retry}>Retry session</button>
}

function SignedOut() {
  const client = useQueryClient()
  const [error, setError] = useState('')
  const [isBusy, setBusy] = useState(false)
  const isMounted = useRef(true)
  useEffect(() => {
    isMounted.current = true
    forgetAccountFacts(client)
    return () => {
      isMounted.current = false
    }
  }, [client])
  const signIn = () => {
    setBusy(true)
    setError('')
    // OAuth is invoked only by this user gesture, never by render or a retry.
    void auth.signIn
      .social({ provider: 'github', callbackURL: window.location.origin })
      .then(
        (receipt) => {
          if (isMounted.current && receipt.error)
            setError('Sign in could not start. Try again.')
        },
        () => {
          if (isMounted.current) setError('Sign in could not start. Try again.')
        },
      )
      .finally(() => {
        if (isMounted.current) setBusy(false)
      })
  }
  return (
    <main>
      <h1>Frame</h1>
      <p>Sign in to access your private Chats.</p>
      <button onClick={signIn} disabled={isBusy}>
        Sign in with GitHub
      </button>
      {error && <p role="alert">{error}</p>}
    </main>
  )
}

type User = NonNullable<ReturnType<typeof sessionResponseSchema.parse>['user']>
function SignedIn({ user }: { user: User }) {
  const client = useQueryClient()
  const logout = useMutation({
    meta: { userID: user.userID },
    mutationFn: () => revokeAccountSession(client, user.userID),
  })
  useEffect(() => {
    client.removeQueries({
      predicate: (query) =>
        query.queryKey[0] === 'user' && query.queryKey[1] !== user.userID,
    })
    return () => {
      forgetAccountFacts(client, user.userID)
    }
  }, [client, user.userID])
  const signOut = () => logout.mutate(undefined)
  return (
    <>
      <header className="identity">
        <span>{user.name}</span>
        <button disabled={logout.isPending} onClick={signOut}>
          Sign out
        </button>
        {logout.isError && <p role="alert">{errorMessage(logout.error)}</p>}
      </header>
      <Chats userID={user.userID} />
    </>
  )
}
