import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { sql } from 'kysely'
import { openTestDatabase, settleTestCleanup } from './database-fixture'
import { startAdministrationChild } from './administration-process-fixture'
import { readMigrationEnv } from '@vid/config'

const script = resolve(import.meta.dir, '../../scripts/assign-legacy-threads.ts')

test('administrative assignment settles a held table lock within its SQL budget', async () => {
  const { db, close } = openTestDatabase()
  const release = Promise.withResolvers<void>()
  let directory: string | undefined
  let blocker: Promise<void> | undefined
  let child: ReturnType<typeof startAdministrationChild> | undefined
  const failures: unknown[] = []
  try {
    directory = await mkdtemp(join(tmpdir(), 'vid-administration-'))
    const entered = Promise.withResolvers<void>()
    blocker = db.transaction().execute(async (tx) => {
      await sql`lock table product.threads in access exclusive mode`.execute(tx)
      entered.resolve()
      await release.promise
    })
    void blocker.catch(() => {})
    await Promise.race([
      entered.promise,
      blocker.then(() => {
        throw new Error('Blocker ended before lock')
      }),
    ])
    const input = join(directory, 'assignments.json')
    await Bun.write(
      input,
      JSON.stringify([{ legacyOwnerID: 'unknown-owner', userID: 'unknown-user' }]),
    )
    child = startAdministrationChild([process.execPath, script, input], {
      ...process.env,
      DATABASE_URL: readMigrationEnv().DATABASE_URL,
      IO_TIMEOUT_MS: '1000',
    })
    const result = await child.result()
    expect(child.forced).toBe(false)
    expect(child.child.signalCode).toBeNull()
    expect(result.code).not.toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/(?:statement|lock) timeout/)
  } catch (cause) {
    failures.push(cause)
  }
  release.resolve()
  await settleTestCleanup([
    async () => {
      failures.push(...((await child?.stop()) ?? []))
    },
    async () => {
      await blocker
    },
    close,
    async () => {
      if (directory !== undefined) await rm(directory, { recursive: true, force: true })
    },
  ]).catch((cause: unknown) => {
    failures.push(cause)
  })
  if (failures.length > 1) throw new AggregateError(failures, 'Administrative fixture failed')
  if (failures.length === 1) throw failures[0]
}, 10000)

test('administrative cleanup retains the primary rejection after closing the actual database', async () => {
  let directory: string | undefined
  let child: ReturnType<typeof startAdministrationChild> | undefined
  const failures: unknown[] = []
  try {
    directory = await mkdtemp(join(tmpdir(), 'vid-administration-'))
    const input = join(directory, 'assignments.json')
    await Bun.write(
      input,
      JSON.stringify([{ legacyOwnerID: 'not-a-retained-owner', userID: 'unknown-user' }]),
    )
    const preload = join(directory, 'close-fault.ts')
    await Bun.write(
      preload,
      `import { Kysely } from ${JSON.stringify(import.meta.resolve('kysely'))};\nconst close = Kysely.prototype.destroy;\nKysely.prototype.destroy = async function () { await close.call(this); throw new Error('fixture-owned-close-failure'); };\n`,
    )
    child = startAdministrationChild([process.execPath, '--preload', preload, script, input], {
      ...process.env,
      DATABASE_URL: readMigrationEnv().DATABASE_URL,
      IO_TIMEOUT_MS: '1000',
    })
    const result = await child.result()
    expect(child.forced).toBe(false)
    expect(child.child.signalCode).toBeNull()
    expect(result.code).not.toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('unknown legacy owner')
    expect(result.stderr).toContain('fixture-owned-close-failure')
  } catch (cause) {
    failures.push(cause)
  }
  await settleTestCleanup([
    async () => {
      failures.push(...((await child?.stop()) ?? []))
    },
    async () => {
      if (directory !== undefined) await rm(directory, { recursive: true, force: true })
    },
  ]).catch((cause: unknown) => {
    failures.push(cause)
  })
  if (failures.length > 1) throw new AggregateError(failures, 'Administrative fixture failed')
  if (failures.length === 1) throw failures[0]
}, 10000)
