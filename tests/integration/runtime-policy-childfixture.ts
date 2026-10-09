// Explicit `bun test ./tests/integration/runtime-policy-childfixture.ts` only.
// Not discovered by the integration suite: every failure here is intentional.
import { expect } from 'bun:test'
import { sql } from 'kysely'
import { openTestDatabase } from './database-fixture'
import { runtimeTestFixture } from './runtime-test-fixture'

const scenario = process.env.VID_RUNTIME_POLICY_SCENARIO
if (!scenario) throw new Error('Explicit runtime policy scenario required')
const test = runtimeTestFixture(async () => {
  console.log('sql-hook-entered')
  const { db, close } = openTestDatabase()
  try {
    if (scenario === 'hookrejection') {
      await sql`select runtime_policy_missing_function()`.execute(db)
    } else if (scenario === 'hookhang') {
      console.log('sql-hook-blocked')
      await sql`select pg_sleep(10)`.execute(db)
    } else {
      await sql`select 1`.execute(db)
    }
    console.log('sql-hook-completed')
  } finally {
    await close()
  }
})

test(`runtime policy ${scenario}`, async () => {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response('owned resource'),
  })
  expect(await (await fetch(server.url)).text()).toBe('owned resource')
  console.log('http-resource-acquired')
  if (scenario === 'partialstartup') {
    console.log('partial-startup-before-finally')
    throw new Error('original partial startup cause')
  }
  async function closeResource() {
    await server.stop(true)
    if (scenario === 'finallyerror') throw new Error('original finally cleanup cause')
  }
  try {
    if (scenario === 'bodytimeout') {
      console.log('body-unresolved')
      await new Promise<void>(() => {})
    }
    if (scenario === 'bodyrejection') throw new Error('original body rejection cause')
  } finally {
    console.log('body-finally')
    await closeResource()
  }
}, 300)

test('next acquisition must not happen after failure', async () => {
  console.log('next-acquisition')
  const server = Bun.serve({ port: 0, fetch: () => new Response('next') })
  await server.stop(true)
})
