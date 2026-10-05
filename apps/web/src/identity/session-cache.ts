import {
  QueryClient,
  QueryCache,
  MutationCache,
  queryOptions,
  type Query,
} from '@tanstack/react-query'
import { getSession, logout as revokeSession } from '@vid/contract/client'
import { HTTPError, abortHTTP, apiForUser, retryRead } from '../http'

export const sessionQuery = queryOptions({
  queryKey: ['session'],
  queryFn: async ({ signal }) =>
    (await getSession({ client: apiForUser(), signal, throwOnError: true }))
      .data,
  retry: retryRead,
  refetchInterval: 30_000,
})

export function forgetAccountFacts(client: QueryClient, userID?: string) {
  abortAccountRequests(client, userID)
  const facts = {
    predicate: (query: Query) =>
      userID === undefined
        ? query.queryKey[0] !== 'session'
        : query.queryKey[0] === 'user' && query.queryKey[1] === userID,
  }
  void client.cancelQueries(facts)
  client.removeQueries(facts)
  if (userID === undefined) {
    client.getMutationCache().clear()
    return
  }
  for (const mutation of client.getMutationCache().getAll()) {
    if (mutation.meta?.userID === userID)
      client.getMutationCache().remove(mutation)
  }
}

// Mutations are not cancellable through QueryClient. Anonymous mounts can still
// have an orphaned mutation, so identify its HTTP owner before clearing facts.
function abortAccountRequests(client: QueryClient, userID?: string) {
  if (userID !== undefined) {
    abortHTTP(userID)
    return
  }
  const account = client.getQueryData(sessionQuery.queryKey)?.user?.userID
  if (account) abortHTTP(account)
  for (const query of client.getQueryCache().findAll({ queryKey: ['user'] })) {
    const owner = query.queryKey[1]
    if (typeof owner === 'string') abortHTTP(owner)
  }
  for (const mutation of client.getMutationCache().getAll()) {
    const owner = mutation.meta?.userID
    if (typeof owner === 'string') abortHTTP(owner)
  }
}

export function publishRevokedSession(
  client: QueryClient,
  requestedUserID?: unknown,
) {
  const currentUserID = client.getQueryData(sessionQuery.queryKey)?.user?.userID
  // A refusal or logout receipt from a previous account cannot revoke the new one.
  if (
    requestedUserID !== undefined &&
    currentUserID &&
    requestedUserID !== currentUserID
  )
    return
  if (currentUserID) abortHTTP(currentUserID)
  void client.cancelQueries()
  // Keep the existing query and its observers; clear() leaves mounted identity
  // observers attached to the old signed-in query instance.
  client.setQueryData(sessionQuery.queryKey, { user: null })
  forgetAccountFacts(client)
}

export async function revokeAccountSession(
  client: QueryClient,
  userID: string,
) {
  // Public logout strongly revokes server access. Better Auth signOut is not
  // substituted here: its best-effort receipt is not the product guarantee.
  await revokeSession({
    client: apiForUser(userID),
    body: {},
    throwOnError: true,
  })
  publishRevokedSession(client, userID)
}

export function createWebQueryClient() {
  const expireSession = (error: Error, requestedUserID?: unknown) => {
    if (error instanceof HTTPError && error.status === 401)
      publishRevokedSession(client, requestedUserID)
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
