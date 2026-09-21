import { SQL } from 'bun'
import { applyMigrations, databaseUrl } from './migrate'

const schemaFile = new URL('../../deploy/database/schema.sql', import.meta.url)
const composeFile = new URL('../../deploy/docker/compose.yaml', import.meta.url).pathname
const adminUrl = new URL(databaseUrl())
const scratchName = `vid_schema_${crypto.randomUUID().replaceAll('-', '')}`

const scratchUrl = new URL(adminUrl)
scratchUrl.pathname = `/${scratchName}`

adminUrl.pathname = '/postgres'
const admin = new SQL(adminUrl.href)

/**
 * Rebuild from migrations in an isolated database; dumping the developer's database
 * would include local drift. Use the pinned PostgreSQL container for stable output.
 */
const generateSchema = async (): Promise<string> => {
  await admin`create database ${admin(scratchName)}`
  const sql = new SQL(scratchUrl.href)

  try {
    await applyMigrations(sql)
  } finally {
    await sql.close()
  }

  const dumpOptions = [
    `--username=${adminUrl.username}`,
    `--dbname=${scratchName}`,
    '--schema-only',
    '--no-owner',
    '--exclude-table=public.applied_migrations',
    '--restrict-key=vid',
  ]
  return Bun.$`docker compose -f ${composeFile} exec --no-TTY db pg_dump ${dumpOptions}`.text()
}

const writeOrCheck = async (): Promise<void> => {
  const schema = await generateSchema()

  if (!process.argv.includes('--check')) {
    await Bun.write(schemaFile, schema)
    return
  }

  if (schema !== (await Bun.file(schemaFile).text()))
    throw new Error('schema is stale; run bun run schema')
}

try {
  await writeOrCheck()
} finally {
  await admin`drop database if exists ${admin(scratchName)}`
  await admin.close()
}
