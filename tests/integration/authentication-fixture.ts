import { betterAuth } from 'better-auth'
import { testUtils } from 'better-auth/plugins'
import { readServerEnv } from '@vid/config'
import type { DB } from '@vid/database/types'
import type { Kysely } from 'kysely'
import {
  authenticationOptions,
  createAuthentication,
} from '../../apps/server/src/identity/authentication'

export const authenticationSettings = {
  baseURL: 'http://127.0.0.1:8787',
  secret: 'isolated-thread-test-secret-not-a-production-key',
  githubClientID: 'fixture-only',
  githubClientSecret: 'fixture-only',
}
export const storageSettings = {
  OBJECT_STORAGE_URL: 'http://unused-storage:9000',
  OBJECT_STORAGE_REGION: 'us-east-1',
  OBJECT_STORAGE_BUCKET: 'workspace-test',
  OBJECT_STORAGE_ACCESS_KEY_ID: 'owned-storage-test',
  OBJECT_STORAGE_SECRET_ACCESS_KEY: 'owned-storage-test-secret',
}
export function serverTestEnv() {
  return readServerEnv({
    DATABASE_URL: process.env.DATABASE_URL,
    REDIS_URL: process.env.REDIS_URL,
    ...storageSettings,
    AUTH_BASE_URL: authenticationSettings.baseURL,
    AUTH_SECRET: authenticationSettings.secret,
    GITHUB_CLIENT_ID: authenticationSettings.githubClientID,
    GITHUB_CLIENT_SECRET: authenticationSettings.githubClientSecret,
  })
}

export async function signedTestIdentity(db: Kysely<DB>) {
  const fixtureAuth = betterAuth({
    ...authenticationOptions(db, authenticationSettings),
    plugins: [officialTestPlugin()],
  })
  const { test: fixture } = await fixtureAuth.$context
  const user = await fixture.saveUser(
    fixture.createUser({
      email: `${crypto.randomUUID()}@thread.example.test`,
      emailVerified: true,
    }),
  )
  const login = await fixture.login({ userId: user.id })
  const headers = new Headers(login.headers)
  headers.set('origin', authenticationSettings.baseURL)
  headers.set('content-type', 'application/json')
  return {
    ...login,
    headers,
    authentication: createAuthentication(db, authenticationSettings),
  }
}

/** Normalize only the SDK declaration's explicit undefined options; do not
 * replace its session creation, signing, or HTTP authentication behavior. */
export function officialTestPlugin() {
  const plugin = testUtils()
  return {
    ...plugin,
    init: (context: Parameters<typeof plugin.init>[0]) => {
      const initialized = plugin.init(context)
      if (!initialized)
        throw new Error('Official test plugin did not initialize')
      return { ...initialized, options: initialized.options ?? {} }
    },
  }
}
