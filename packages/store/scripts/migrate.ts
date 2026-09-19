/**
 * Puts every committed migration on whatever `DATABASE_URL` names, exactly once each.
 *
 * A deploy step, not library code: nothing a running service imports. That is why it lives
 * beside the migrations rather than in `src/`, where everything is something a service
 * holds open for its whole life.
 *
 * The migrations are plain SQL because plain SQL is what runs. Nothing generates a
 * statement nobody wrote, so reviewing a change means reading the change.
 *
 * Each file runs inside a transaction together with the record that it ran, so a file that
 * fails leaves neither half of itself behind. Postgres does DDL transactionally, which is
 * what makes that possible and most of why this is short.
 *
 * Files are named `YYYYMMDDHHMMSS-what-it-does.sql` and applied in that order. A counter
 * would collide the moment two branches each add one, and whichever merged second would
 * quietly reorder the other's.
 *
 * There is no `down`. A migration that was wrong is fixed by a later migration: reversing
 * one on a database that has taken writes since is a guess.
 *
 * What these files add up to is written out by `schema.ts` into `schema.sql`, so nobody has to replay them in
 * their head to know what a table looks like.
 */
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { SQL } from 'bun'

const DIRECTORY = new URL('../migrations/', import.meta.url).pathname

export const applyMigrations = async (sql: SQL): Promise<readonly string[]> => {
  await sql`
    create table if not exists applied_migrations (
      name       text        primary key,
      applied_at timestamptz not null default now()
    )
  `

  const applied = new Set(
    (await sql`select name from applied_migrations`).map((row: { name: string }) => row.name),
  )

  const pending = (await readdir(DIRECTORY))
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .filter((name) => !applied.has(name))

  for (const name of pending) {
    const statements = await Bun.file(join(DIRECTORY, name)).text()

    await sql.begin(async (tx) => {
      await tx.unsafe(statements)
      await tx`insert into applied_migrations (name) values (${name})`
    })
  }

  return pending
}

export const databaseUrl = (): string => {
  const url = process.env['DATABASE_URL']
  if (url === undefined || url === '') throw new Error('DATABASE_URL is not set')
  return url
}

if (process.argv[1] === import.meta.filename) {
  const sql = new SQL(databaseUrl())
  const applied = await applyMigrations(sql)
  await sql.close()

  console.log(applied.length === 0 ? 'already up to date' : `applied:\n  ${applied.join('\n  ')}`)
}
