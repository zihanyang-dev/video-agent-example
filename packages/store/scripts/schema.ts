/**
 * Writes `schema.sql`: what every committed migration adds up to.
 *
 * Read by whoever wants to know what a table looks like without replaying the migrations in
 * their head, and diffed by `check`, which is what catches a migration doing something
 * other than what its author believed.
 *
 * It is a review artefact and never restored. Loading it would make a database the
 * migration runner believes is empty, and the next run would replay every file onto tables
 * that already exist. `bun run migrate` is the only way to build one.
 *
 * Dumped rather than described. A description assembled from catalog queries can only cover
 * the cases someone thought to ask about -- the first check constraint, trigger or function
 * would be silently missing from a file whose whole value is that it is complete.
 *
 * Built on a database made for the purpose and dropped afterwards. Dumping the development
 * database instead would put whatever else has ever been in it -- another branch's tables, a
 * hand-run experiment -- into a file this repository keeps.
 */
import { SQL } from 'bun'
import { applyMigrations, databaseUrl } from './migrate'

const SCRATCH = 'vid_schema_only'
const OUTPUT = new URL('../schema.sql', import.meta.url).pathname
const COMPOSE = new URL('../../../deploy/docker/compose.yaml', import.meta.url).pathname

/** The runner's own bookkeeping is not part of our schema. */
const NOT_OURS = 'applied_migrations'

/**
 * Any fixed value works. `pg_dump` otherwise stamps a random one into every dump, and the
 * diff in `check` would fail on every run for a change nobody made.
 */
const RESTRICT_KEY = 'vid'

/**
 * Run inside the container, so the client always matches the server and a fresh clone needs
 * nothing installed but Docker. The image's patch version is pinned for the same reason:
 * pg_dump writes its own version into the dump.
 */
const dump = async (database: string, user: string): Promise<string> => {
  const dumped =
    await Bun.$`docker compose -f ${COMPOSE} exec --no-TTY db pg_dump --username=${user} --dbname=${database} --schema-only --no-owner --no-privileges --exclude-table=${NOT_OURS} --restrict-key=${RESTRICT_KEY}`.text()

  if (dumped.trim() === '') throw new Error('pg_dump produced nothing')
  return dumped
}

const url = new URL(databaseUrl())

const scratchUrl = new URL(url.href)
scratchUrl.pathname = `/${SCRATCH}`

const adminUrl = new URL(url.href)
adminUrl.pathname = '/postgres'

const admin = new SQL(adminUrl.href)
await admin`drop database if exists ${admin(SCRATCH)}`
await admin`create database ${admin(SCRATCH)}`

const scratch = new SQL(scratchUrl.href)
await applyMigrations(scratch)
await scratch.close()

await Bun.write(OUTPUT, await dump(SCRATCH, url.username))

await admin`drop database if exists ${admin(SCRATCH)}`
await admin.close()

console.log(`wrote ${OUTPUT}`)
