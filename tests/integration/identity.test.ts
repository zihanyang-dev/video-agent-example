import { connect } from 'node:net'
import { startServer } from '../../apps/server/src/server'
import {
  signedTestIdentity,
  serverTestEnv,
  authenticationSettings,
  officialTestPlugin,
} from './authentication-fixture'
import { afterAll, expect, test } from 'bun:test'
import { betterAuth } from 'better-auth'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { Pool } from 'pg'
import type { DB } from '@vid/database/types'
import { readMigrationEnv } from '@vid/config'
import {
  authenticationOptions,
  createAuthentication,
  readIdentity,
  signOut,
} from '../../apps/server/src/identity/authentication'
import { openTestDatabase } from './database-fixture'

const { db, close } = openTestDatabase()
const settings = {
  baseURL: 'http://127.0.0.1:8787',
  secret: 'isolated-identity-test-secret-not-a-production-key',
  githubClientID: 'fixture-only',
  githubClientSecret: 'fixture-only',
}
const bodyCollection = { signal: new AbortController().signal, timeoutMs: 1000 }
const auth = createAuthentication(db, settings)
const fixtures = betterAuth({
  ...authenticationOptions(db, settings),
  plugins: [officialTestPlugin()],
})
const users: string[] = []

afterAll(async () => {
  try {
    if (users.length) await db.deleteFrom('auth.user').where('id', 'in', users).execute()
  } finally {
    await close()
  }
})

async function signedIdentity() {
  const { test: fixture } = await fixtures.$context
  const user = await fixture.saveUser(
    fixture.createUser({
      email: `${crypto.randomUUID()}@identity.example.test`,
      emailVerified: true,
    }),
  )
  users.push(user.id)
  return await fixture.login({ userId: user.id })
}

function logoutRequest(headers: Headers, origin = settings.baseURL) {
  const requestHeaders = new Headers(headers)
  requestHeaders.set('origin', origin)
  requestHeaders.set('content-type', 'application/json')
  return new Request(`${settings.baseURL}/api/logout`, {
    method: 'POST',
    headers: requestHeaders,
    body: '{}',
  })
}

test('official signed-cookie fixtures authenticate without production test routes', async () => {
  const login = await signedIdentity()
  const identity = await readIdentity(auth, login.headers)
  expect(identity?.id).toBe(login.user.id)
  expect(identity?.emailVerified).toBe(true)
  expect(await readIdentity(auth, new Headers())).toBeNull()
})

test('a changed cookie cannot impersonate its stored session', async () => {
  const login = await signedIdentity()
  const headers = new Headers(login.headers)
  const cookie = headers.get('cookie')
  if (!cookie) throw new Error('Official fixture did not issue a cookie')
  headers.set('cookie', cookie.replace('=', '=changed-'))
  expect(await readIdentity(auth, headers)).toBeNull()
})

test('database expiry is authoritative on the next read', async () => {
  const login = await signedIdentity()
  expect((await readIdentity(auth, login.headers))?.id).toBe(login.user.id)
  await db
    .updateTable('auth.session')
    .set({ expiresAt: new Date(0) })
    .where('id', '=', login.session.id)
    .execute()
  expect(await readIdentity(auth, login.headers)).toBeNull()
})

test('a foreign-origin logout does not revoke the authenticated session', async () => {
  const login = await signedIdentity()
  const response = await signOut(
    auth,
    db,
    logoutRequest(login.headers, 'https://attacker.example'),
    bodyCollection,
  )
  expect(response.status).toBe(403)
  expect((await readIdentity(auth, login.headers))?.id).toBe(login.user.id)
})

test('logout revokes the server session before acknowledging and expiring the cookie', async () => {
  const login = await signedIdentity()
  const response = await signOut(auth, db, logoutRequest(login.headers), bodyCollection)
  expect(response.status).toBe(200)
  expect(response.headers.get('set-cookie')).toContain('Max-Age=0')
  expect(await readIdentity(auth, login.headers)).toBeNull()
})

test('failed session deletion is not a successful logout or an expired retry cookie', async () => {
  const login = await signedIdentity()
  let release!: () => void
  let entered!: () => void
  const unlocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const locked = new Promise<void>((resolve) => {
    entered = resolve
  })
  const blocker = db.transaction().execute(async (tx) => {
    await sql`select id from auth.session where id = ${login.session.id} for update`.execute(tx)
    entered()
    await unlocked
  })
  const boundedDB = new Kysely<DB>({
    dialect: new PostgresDialect({
      pool: new Pool({
        connectionString: readMigrationEnv().DATABASE_URL,
        statement_timeout: 100,
      }),
    }),
  })
  const boundedAuth = createAuthentication(boundedDB, settings)
  try {
    await locked
    const failed = await signOut(
      boundedAuth,
      boundedDB,
      logoutRequest(login.headers),
      bodyCollection,
    ).then(
      () => null,
      (cause: unknown) => cause,
    )
    expect(String(failed)).toContain('statement timeout')
    expect((await readIdentity(auth, login.headers))?.id).toBe(login.user.id)
  } finally {
    release()
    await blocker
    await boundedDB.destroy()
  }
})

test('the library sign-out HTTP route cannot bypass strict revocation handling', async () => {
  const login = await signedIdentity()
  for (const path of ['/api/auth/sign-out', '/api/auth/sign-out/']) {
    const response = await auth.handler(
      new Request(`${settings.baseURL}${path}`, {
        method: 'POST',
        headers: logoutRequest(login.headers).headers,
        body: '{}',
      }),
    )
    expect(response.status).toBe(404)
  }
  expect((await readIdentity(auth, login.headers))?.id).toBe(login.user.id)
})

test('an OAuth provider identity cannot be assigned to two users', async () => {
  const first = await signedIdentity()
  const second = await signedIdentity()
  const account = {
    accountId: crypto.randomUUID(),
    providerId: 'github',
    userId: first.user.id,
    updatedAt: new Date(),
  }
  await db
    .insertInto('auth.account')
    .values({ ...account, id: crypto.randomUUID() })
    .execute()
  const rejected = await db
    .insertInto('auth.account')
    .values({
      ...account,
      id: crypto.randomUUID(),
      userId: second.user.id,
    })
    .execute()
    .then(
      () => null,
      (cause: unknown) => cause,
    )
  expect(String(rejected)).toContain('unique')
})

test('logout rejects oversized JSON without revoking the durable retry session', async () => {
  const login = await signedIdentity()
  const request = new Request(`${settings.baseURL}/api/logout`, {
    method: 'POST',
    headers: logoutRequest(login.headers).headers,
    body: JSON.stringify({ padding: 'x'.repeat(65536) }),
  })
  const response = await signOut(auth, db, request, bodyCollection)
  expect(response.status).toBe(413)
  expect(response.headers.get('set-cookie')).toBeNull()
  expect((await readIdentity(auth, login.headers))?.id).toBe(login.user.id)
})

test('native server releases its request budget after trickling product and logout JSON deadlines without revoking sessions', async () => {
  const login = await signedTestIdentity(db)
  users.push(login.user.id)
  const server = await startServer({ ...serverTestEnv(), FILE_IO_TIMEOUT_MS: 400 }, { port: 0 })
  const clients: ReturnType<typeof tricklingJSON>[] = []
  try {
    for (let index = 0; index < 16; index++)
      clients.push(
        tricklingJSON(server.url, login.headers, index < 8 ? '/api/logout' : '/api/threads'),
      )
    await Promise.all(clients.map((client) => client.connected))
    const saturated = await fetch(`${server.url}/api/session`)
    expect(saturated.status).toBe(429)
    const statuses = await Promise.race([
      Promise.all(clients.map((client) => client.status)),
      Bun.sleep(1500).then(() => [] as number[]),
    ])
    expect(statuses).toContain(408)
    expect(statuses.every((status) => status === 408 || status === 429)).toBe(true)
    expect(clients.some((client) => client.chunks() > 1)).toBe(true)
    const released = await fetch(`${server.url}/api/session`, {
      headers: login.headers,
    })
    expect(released.status).toBe(200)
    expect(((await released.json()) as { user: { userID: string } }).user.userID).toBe(
      login.user.id,
    )
    expect((await readIdentity(login.authentication, login.headers))?.id).toBe(login.user.id)
  } finally {
    for (const client of clients) client.close()
    await server.stop()
  }
})

test('native server shutdown settles an unfinished JSON body before closing resources', async () => {
  const login = await signedTestIdentity(db)
  users.push(login.user.id)
  const server = await startServer({ ...serverTestEnv(), FILE_IO_TIMEOUT_MS: 5000 }, { port: 0 })
  const client = tricklingJSON(server.url, login.headers, '/api/logout')
  try {
    await client.connected
    await Bun.sleep(30)
    const stopped = server.stop()
    expect(await Promise.race([stopped.then(() => true), Bun.sleep(1000).then(() => false)])).toBe(
      true,
    )
    await stopped
    expect((await readIdentity(login.authentication, login.headers))?.id).toBe(login.user.id)
  } finally {
    client.close()
    await server.stop()
  }
})

function tricklingJSON(url: string, headers: Headers, path: string) {
  const address = new URL(url)
  let count = 0
  let timer: ReturnType<typeof setInterval> | undefined
  let connected!: () => void
  let finish!: (status: number) => void
  const ready = new Promise<void>((resolve) => {
    connected = resolve
  })
  const status = new Promise<number>((resolve) => {
    finish = resolve
  })
  const socket = connect({ host: address.hostname, port: Number(address.port) }, () => {
    socket.write(
      `POST ${path} HTTP/1.1\r\nHost: ${address.host}\r\nOrigin: ${authenticationSettings.baseURL}\r\nCookie: ${headers.get('cookie')}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n`,
    )
    socket.write('1\r\n \r\n')
    timer = setInterval(() => {
      count++
      socket.write('1\r\n \r\n')
    }, 10)
    connected()
  })
  let response = ''
  socket.on('data', (bytes) => {
    response += bytes.toString()
    const match = /^HTTP\/1\.1 (\d+)/.exec(response)
    if (match) {
      clearInterval(timer)
      finish(Number(match[1]))
    }
  })
  socket.on('error', () => {
    clearInterval(timer)
    finish(0)
    connected()
  })
  socket.on('close', () => {
    clearInterval(timer)
    finish(0)
  })
  return {
    connected: ready,
    status,
    chunks: () => count,
    close: () => {
      clearInterval(timer)
      socket.destroy()
    },
  }
}
