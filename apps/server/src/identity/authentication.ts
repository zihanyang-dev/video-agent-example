import { betterAuth, type BetterAuthOptions } from 'better-auth'
import type { Kysely } from 'kysely'
import type { DB } from '@vid/database/types'
import { openAPI } from 'better-auth/plugins'
import { revokeSession } from '../db/sessions'
import {
  readBody,
  requestBodyRejection,
  type BodyCollectionPolicy,
} from '../request-body'
import { publicSchemas } from '@vid/contract/http'

export type AuthenticationSettings = Readonly<{
  baseURL: string
  secret: string
  githubClientID: string
  githubClientSecret: string
}>

/** Authentication owns identity and cookies, not thread ownership. Connection
 * lifetime belongs to the server; schema changes belong exclusively to dbmate.
 * Returning native options also lets test fixtures add the official test plugin
 * without adding privileged HTTP routes or a production authentication bypass.
 */
export function authenticationOptions(
  db: Kysely<DB> | undefined,
  settings: AuthenticationSettings,
) {
  return {
    ...(db
      ? {
          database: {
            db,
            type: 'postgres' as const,
            schemaName: 'auth',
            transaction: true,
          },
        }
      : {}),
    baseURL: settings.baseURL,
    basePath: '/api/auth',
    // Disable every normalized HTTP spelling of the SDK's best-effort logout.
    // The app's /api/logout uses its native server API only after DB revocation.
    disabledPaths: ['/sign-out'],
    plugins: [openAPI({ disableDefaultReference: true })],
    secret: settings.secret,
    trustedOrigins: [settings.baseURL],
    // SDK errors may contain driver inputs. The application owns safe diagnostics.
    logger: { disabled: true },
    session: {
      expiresIn: 7 * 24 * 60 * 60,
      updateAge: 24 * 60 * 60,
      cookieCache: { enabled: false },
    },
    account: {
      accountLinking: { enabled: false },
      encryptOAuthTokens: true,
    },
    socialProviders: {
      github: {
        clientId: settings.githubClientID,
        clientSecret: settings.githubClientSecret,
      },
    },
  } satisfies BetterAuthOptions
}

export function createAuthentication(
  db: Kysely<DB>,
  settings: AuthenticationSettings,
) {
  return betterAuth(authenticationOptions(db, settings))
}

type Authentication = ReturnType<typeof createAuthentication>

/** A stream calls this for every batch. No cached cookie verdict and no session
 * extension from background reads after response headers have been committed.
 */
export async function readIdentity(auth: Authentication, headers: Headers) {
  const session = await auth.api.getSession({
    headers,
    query: { disableCookieCache: true, disableRefresh: true },
  })
  return session?.user ?? null
}

/** Cookie authentication does not authorize a cross-origin state change.
 * Validate first, revoke next, then ask the SDK to expire its own cookies. If
 * deletion fails, leave the cookie intact so the caller can retry; do not turn
 * best-effort cleanup into a false successful logout or hand-sign any cookie.
 */
export async function signOut(
  auth: Authentication,
  db: Kysely<DB>,
  request: Request,
  bodyCollection: BodyCollectionPolicy,
) {
  if (request.method !== 'POST')
    return new Response('Method not allowed', { status: 405 })
  if (request.headers.get('origin') !== auth.options.baseURL)
    return new Response('Untrusted request origin', { status: 403 })
  if (
    request.headers.get('content-type')?.split(';')[0]?.trim() !==
    'application/json'
  )
    return new Response('Expected JSON request', { status: 415 })

  let body: unknown
  try {
    body = await readBody(request, bodyCollection)
  } catch (cause) {
    const rejection = requestBodyRejection(cause)
    if (rejection) return rejection
    throw cause
  }
  if (!publicSchemas.EmptyRequest.safeParse(body).success)
    return Response.json({ error: 'Invalid input' }, { status: 400 })

  const session = await auth.api.getSession({
    headers: request.headers,
    query: { disableCookieCache: true, disableRefresh: true },
  })
  if (session !== null)
    await revokeSession(db, {
      sessionID: session.session.id,
      userID: session.user.id,
    })
  return await auth.api.signOut({ headers: request.headers, asResponse: true })
}
