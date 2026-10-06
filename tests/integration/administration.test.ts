import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { sql } from 'kysely'
import { openTestDatabase } from './database-fixture'
import { readMigrationEnv } from '@vid/config'

const script = resolve(
  import.meta.dir,
  '../../scripts/assign-legacy-threads.ts',
)

test('administrative assignment settles a held table lock within its SQL budget', async () => {
  const { db, close } = openTestDatabase()
  const directory = await mkdtemp(join(tmpdir(), 'vid-administration-'))
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const blocker = db.transaction().execute(async (tx) => {
    await sql`lock table product.threads in access exclusive mode`.execute(tx)
    entered.resolve()
    await release.promise
  })
  let child: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined
  let forced = false
  try {
    await entered.promise
    const input = join(directory, 'assignments.json')
    await Bun.write(
      input,
      JSON.stringify([
        { legacyOwnerID: 'unknown-owner', userID: 'unknown-user' },
      ]),
    )
    child = Bun.spawn(['bun', script, input], {
      env: {
        ...process.env,
        DATABASE_URL: readMigrationEnv().DATABASE_URL,
        IO_TIMEOUT_MS: '1000',
      },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const stdout = new Response(child.stdout).text()
    const stderr = new Response(child.stderr).text()
    const owned = child
    deadline = setTimeout(() => {
      forced = true
      owned.kill()
    }, 3500)
    const code = await child.exited
    expect(forced).toBe(false)
    expect(code).not.toBe(0)
    expect(await stdout).toBe('')
    // Equal statement/lock budgets race; either native deadline is valid.
    expect(await stderr).toMatch(/(?:statement|lock) timeout/)
  } finally {
    if (deadline !== undefined) clearTimeout(deadline)
    if (child !== undefined) {
      child.kill()
      await child.exited
    }
    release.resolve()
    await blocker
    await close()
    await rm(directory, { recursive: true, force: true })
  }
}, 10000)

test('administrative cleanup retains the primary rejection after closing the actual database', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vid-administration-'))
  let child: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined
  try {
    const input = join(directory, 'assignments.json')
    await Bun.write(
      input,
      JSON.stringify([
        { legacyOwnerID: 'not-a-retained-owner', userID: 'unknown-user' },
      ]),
    )
    // Inject only an additional close failure: the native pool still closes.
    const preload = join(directory, 'close-fault.ts')
    await Bun.write(
      preload,
      `import { Kysely } from ${JSON.stringify(import.meta.resolve('kysely'))};\nconst close = Kysely.prototype.destroy;\nKysely.prototype.destroy = async function () { await close.call(this); throw new Error('fixture-owned-close-failure'); };\n`,
    )
    child = Bun.spawn(['bun', '--preload', preload, script, input], {
      env: {
        ...process.env,
        DATABASE_URL: readMigrationEnv().DATABASE_URL,
        IO_TIMEOUT_MS: '1000',
      },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const stdout = new Response(child.stdout).text()
    const stderr = new Response(child.stderr).text()
    expect(await child.exited).not.toBe(0)
    expect(await stdout).toBe('')
    const diagnostic = await stderr
    expect(diagnostic).toContain('unknown legacy owner')
    expect(diagnostic).toContain('fixture-owned-close-failure')
  } finally {
    if (child !== undefined) {
      child.kill()
      await child.exited
    }
    await rm(directory, { recursive: true, force: true })
  }
}, 10000)
