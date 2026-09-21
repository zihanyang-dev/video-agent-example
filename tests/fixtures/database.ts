import { SQL } from 'bun'
import { applyMigrations } from '../../scripts/database/migrate'

/**
 * Each fixture replays the real migrations in its own database. The two runtime
 * connections use application roles so tests also exercise schema permissions.
 */
export const createTestDatabase = async (seed?: (sql: SQL) => Promise<void>) => {
  const url = new URL(process.env['DATABASE_URL'] ?? 'postgres://vid:vid@localhost:5432/vid')
  const admin = new SQL(url.toString())
  const name = `test_${crypto.randomUUID().replaceAll('-', '')}`

  await admin.unsafe(`create database ${name}`)
  url.pathname = `/${name}`
  const sql = new SQL(url.toString())

  await seed?.(sql)
  await applyMigrations(sql)

  const product = new SQL(url.toString(), { connection: { role: 'vid_product' } })
  const execution = new SQL(url.toString(), { connection: { role: 'vid_execution' } })

  return {
    sql,
    product,
    execution,
    close: async () => {
      await Promise.all([sql.close(), product.close(), execution.close()])
      await admin.unsafe(`drop database ${name} with (force)`)
      await admin.close()
    },
  }
}
