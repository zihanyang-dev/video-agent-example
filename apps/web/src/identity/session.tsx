import { useEffect, useRef, useState } from 'react'
import { createAuthClient } from 'better-auth/react'
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
  QueryClient,
  QueryCache,
  MutationCache,
} from '@tanstack/react-query'
import { sessionResponseSchema } from '@vid/contract/http'
import {
  errorMessage,
  HTTPError,
  apiForUser,
  abortHTTP,
  retryRead,
} from '../http'
import { getSession, logout as revokeSession } from '@vid/contract/client'
import { Chats } from '../conversations/chats'

const auth = createAuthClient({ basePath: '/api/auth' })
export const sessionQuery = queryOptions({
  queryKey: ['session'],
  queryFn: async ({ signal }) =>
    (await getSession({ client: apiForUser(), signal, throwOnError: true }))
      .data,
  retry: retryRead,
  refetchInterval: 30_000,
})

export function createWebQueryClient() {
  const expireSession = (error: Error, requestedUserID?: unknown) => {
    if (!(error instanceof HTTPError) || error.status !== 401) return
    const currentUserID = client.getQueryData(sessionQuery.queryKey)?.user
      ?.userID
    // A late refusal from a previous account must not sign out the new one.
    if (requestedUserID !== undefined && requestedUserID !== currentUserID)
      return
    if (currentUserID) abortHTTP(currentUserID)
    void client.cancelQueries({ queryKey: ['user'] })
    client.getMutationCache().clear()
    client.setQueryData(sessionQuery.queryKey, { user: null })
    client.removeQueries({ queryKey: ['user'] })
  }
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: retryRead },
      mutations: { retry: false },
    },
    queryCache: new QueryCache({
      onError: (error, query) =>
        expireSession(
          error,
          query.queryKey[0] === 'user' ? query.queryKey[1] : undefined,
        ),
    }),
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) =>
        expireSession(error, mutation.meta?.userID),
    }),
  })
  return client
}

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
    client.removeQueries({
      predicate: (query) => query.queryKey[0] !== 'session',
    })
    client.getMutationCache().clear()
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
    mutationFn: async () => {
      await revokeSession({
        client: apiForUser(user.userID),
        body: {},
        throwOnError: true,
      })
    },
  })
  useEffect(() => {
    client.removeQueries({
      predicate: (query) =>
        query.queryKey[0] === 'user' && query.queryKey[1] !== user.userID,
    })
    return () => {
      abortHTTP(user.userID)
      // Stop stale reads before removing their facts on account changes.
      void client.cancelQueries({ queryKey: ['user', user.userID] })
      client.removeQueries({ queryKey: ['user', user.userID] })
      client.getMutationCache().clear()
    }
  }, [client, user.userID])
  const signOut = () =>
    logout.mutate(undefined, {
      onSuccess: () => {
        // Public logout strongly revokes server access. Better Auth signOut is not
        // substituted here: its best-effort receipt is not the product guarantee.
        abortHTTP(user.userID)
        void client.cancelQueries()
        // Keep the session observer attached: clearing its query first leaves
        // mounted identity observers holding the old signed-in result.
        client.setQueryData(sessionQuery.queryKey, { user: null })
        client.removeQueries({
          predicate: (query) => query.queryKey[0] !== 'session',
        })
        client.getMutationCache().clear()
      },
    })
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
