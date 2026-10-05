import { queryOptions } from '@tanstack/react-query'
import { listThreads, getThread, listMessages } from '@vid/contract/client'
import { apiForUser } from '../http'

export type ThreadScope = Readonly<{ userID: string; threadID: string }>
export function threadsQuery(userID: string) {
  return queryOptions({
    queryKey: ['user', userID, 'threads'],
    queryFn: async ({ signal }) =>
      (
        await listThreads({
          client: apiForUser(userID),
          signal,
          throwOnError: true,
        })
      ).data,
  })
}
export function threadQuery(scope: ThreadScope) {
  return queryOptions({
    queryKey: ['user', scope.userID, scope.threadID, 'thread'],
    queryFn: async ({ signal }) =>
      (
        await getThread({
          client: apiForUser(scope.userID),
          path: { threadID: scope.threadID },
          signal,
          throwOnError: true,
        })
      ).data,
    refetchInterval: 15_000,
  })
}
export function messagesQuery(scope: ThreadScope) {
  return queryOptions({
    queryKey: ['user', scope.userID, scope.threadID, 'messages'],
    queryFn: async ({ signal }) =>
      (
        await listMessages({
          client: apiForUser(scope.userID),
          path: { threadID: scope.threadID },
          signal,
          throwOnError: true,
        })
      ).data,
    refetchInterval: 5_000,
  })
}
