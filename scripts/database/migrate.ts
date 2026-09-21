import { readdir } from 'node:fs/promises'
import { SQL } from 'bun'

const ROOT = new URL('../../', import.meta.url)
const DIRECTORIES = ['apps/server/migrations/', 'apps/agent/migrations/']

/**
 * Deployment orders migrations across both owners by their timestamped names.
 * Each file commits with its ledger entry, so a failed migration remains retryable
 * without leaving partial DDL behind.
 */
export const applyMigrations = async (sql: SQL): Promise<readonly string[]> => {
  await sql`
    create table if not exists public.applied_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )
  `
  const applied = new Set(
    (await sql`select name from public.applied_migrations`).map(
      (row: { name: string }) => row.name,
    ),
  )

  const migrations = await availableMigrations()
  const pending = migrations.filter((migration) => !applied.has(migration.name))

  for (const migration of pending) {
    const statements = await Bun.file(migration.path).text()
    await sql.begin(async (tx) => {
      await tx.unsafe(statements)
      await tx`insert into public.applied_migrations (name) values (${migration.name})`
    })
  }

  return pending.map((migration) => migration.name)
}

const availableMigrations = async () => {
  const migrations: { name: string; path: string }[] = []

  for (const directory of DIRECTORIES) {
    const path = new URL(directory, ROOT)
    const names = (await readdir(path)).filter((name) => name.endsWith('.sql'))
    migrations.push(...names.map((name) => ({ name, path: new URL(name, path).pathname })))
  }

  return migrations.sort((left, right) => left.name.localeCompare(right.name))
}

export const databaseUrl = (): string => {
  const url = process.env['DATABASE_URL']
  if (!url) throw new Error('DATABASE_URL is not set')

  return url
}

if (import.meta.main) {
  const sql = new SQL(databaseUrl())

  try {
    console.log(await applyMigrations(sql))
  } finally {
    await sql.close()
  }
}
