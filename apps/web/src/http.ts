import { createClient } from '@vid/contract/fetch'
export class HTTPError extends Error {
  constructor(readonly status: number) {
    super(
      status === 401
        ? 'Your session ended. Sign in again.'
        : status === 403 || status === 404
          ? 'This content is no longer available to you. Refresh your Chats.'
          : status === 409
            ? 'This change conflicts with current server facts. Refresh before continuing.'
            : status === 413
              ? 'The file is too large for this server. Choose a smaller file.'
              : status === 400 || status === 415 || status === 422
                ? 'The server rejected this input. Check the file type, size, name, and message.'
                : 'Request not confirmed. Check your connection and retry.',
    )
  }
}

// The generated client owns serialization and paths; this adapter owns the
// same-origin cookie boundary, safe errors, and account-scoped HTTP shutdown.
const active = new Map<string, Set<AbortController>>()
export function abortHTTP(userID: string) {
  for (const controller of active.get(userID) ?? []) controller.abort()
  active.delete(userID)
}

export function apiForUser(userID = '') {
  return createClient({
    baseUrl:
      typeof window === 'undefined'
        ? 'http://localhost'
        : window.location.origin,
    credentials: 'same-origin',
    throwOnError: true,
    fetch: Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        const controller = new AbortController()
        const controllers = active.get(userID) ?? new Set<AbortController>()
        active.set(userID, controllers)
        controllers.add(controller)
        const signal = AbortSignal.any([request.signal, controller.signal])
        try {
          return await fetchSafe(new Request(request, { signal }))
        } finally {
          controllers.delete(controller)
          if (controllers.size === 0 && active.get(userID) === controllers)
            active.delete(userID)
        }
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  })
}

async function fetchSafe(request: Request) {
  let response: Response
  try {
    response = await fetch(request, { credentials: 'same-origin' })
  } catch {
    throw new HTTPError(0)
  }
  if (!response.ok) throw new HTTPError(response.status)
  return response
}

export function retryRead(failureCount: number, error: Error): boolean {
  // Authority denials are not transient outages; never automatically retry them.
  if (error instanceof HTTPError && [401, 403, 404, 409].includes(error.status))
    return false
  return failureCount < 2
}

export function errorMessage(error: unknown): string {
  if (error instanceof HTTPError) return error.message
  return 'Request not confirmed. Refresh or retry to recover.'
}
