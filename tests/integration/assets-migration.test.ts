import { test, expect } from 'bun:test'
import { mkdtemp, readdir, copyFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, Pool } from 'pg'
import { Kysely, PostgresDialect } from 'kysely'
import type { DB } from '@vid/database/types'
import { acceptExecutionEvent } from '../../apps/server/src/db/execution-events'
import { snapshotOwnedMessages } from '../../apps/server/src/db/conversations'
import { readMigrationEnv } from '@vid/config'
import {
  executionCommandSchema,
  executionDeliverySchema,
} from '@vid/contract/execution'

const migration = '20261004040000_assets.sql'
const ids = {
  thread: 'aaaaaaaa-0000-4000-8000-000000000001',
  message: 'bbbbbbbb-0000-4000-8000-000000000002',
  command: 'cccccccc-0000-4000-8000-000000000003',
  run: 'dddddddd-0000-4000-8000-000000000004',
  asset: '00000000-0000-4000-8000-000000000005',
  assistant: '00000000-0000-4000-8000-000000000006',
}

/** Exercise dbmate itself against an owned database at the actual old schema,
 * not a rebuilt imitation of the old tables or a source-text assertion. */
async function legacyDatabase() {
  const url = new URL(readMigrationEnv().DATABASE_URL)
  const admin = new Client({ connectionString: url.toString() })
  const name = `asset_migration_${crypto.randomUUID().replaceAll('-', '')}`
  const directory = await mkdtemp(join(tmpdir(), 'asset-migration-'))
  const db = new Client({ connectionString: databaseURL(url, name) })
  await admin.connect()
  let created = false
  const close = async () => {
    await db.end()
    try {
      // The identifier is generated locally from a UUID, never caller input.
      if (created) await admin.query(`DROP DATABASE "${name}"`)
    } finally {
      await admin.end()
      await rm(directory, { recursive: true, force: true })
    }
  }
  try {
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`)
    created = true
    const files = (await readdir('packages/database/migrations')).filter(
      (file) => file.endsWith('.sql') && file < migration,
    )
    for (const file of files)
      await copyFile(
        join('packages/database/migrations', file),
        join(directory, file),
      )
    expect(await migrate(directory, databaseURL(url, name))).toBe(0)
    await db.connect()
    await db.query(
      `INSERT INTO auth."user" (id,name,email,"emailVerified") VALUES ('migration-user','Migration user','migration@example.invalid',true)`,
    )
    await db.query(
      'INSERT INTO product.threads (thread_id,owner_id) VALUES ($1,$2)',
      [ids.thread, 'migration-user'],
    )
    await db.query(
      "INSERT INTO product.messages (message_id,thread_id,role,text) VALUES ($1,$3,'user','Historical input'),($2,$3,'assistant','Historical output')",
      [ids.message, ids.assistant, ids.thread],
    )
    return {
      db,
      url: databaseURL(url, name),
      close,
      upgrade: async (through = migration) => {
        const upgrades = (await readdir('packages/database/migrations')).filter(
          (file) =>
            file.endsWith('.sql') && file >= migration && file <= through,
        )
        for (const file of upgrades)
          await copyFile(
            join('packages/database/migrations', file),
            join(directory, file),
          )
        return await migrate(directory, databaseURL(url, name))
      },
    }
  } catch (cause) {
    await close()
    throw cause
  }
}

function databaseURL(url: URL, database: string) {
  const connection = new URL(url)
  connection.pathname = `/${database}`
  return connection.toString()
}

async function migrate(directory: string, url: string) {
  const process = Bun.spawn(
    [
      'bun',
      'run',
      '--cwd',
      'packages/database',
      'dbmate',
      '--migrations-dir',
      directory,
      '--no-dump-schema',
      'migrate',
    ],
    {
      env: { PATH: globalThis.process.env.PATH, DATABASE_URL: url },
      stdout: 'ignore',
      stderr: 'ignore',
    },
  )
  // No credentials enter argv or diagnostic output. A stalled migration must
  // settle before teardown tries to remove its database.
  const timeout = setTimeout(() => process.kill(), 10000)
  try {
    return await process.exited
  } finally {
    clearTimeout(timeout)
  }
}

async function seedCommand(db: Client, materials: unknown[]) {
  const command = {
    version: 1,
    kind: 'start',
    commandID: ids.command,
    threadID: ids.thread,
    runID: ids.run,
    input: { messageID: ids.message, text: 'Historical input', materials },
  }
  await db.query(
    'INSERT INTO product.command_outbox (command_id,thread_id,run_id,message_id,command) VALUES ($1,$2,$3,$4,$5)',
    [ids.command, ids.thread, ids.run, ids.message, command],
  )
  await db.query(
    "INSERT INTO execution.command_inbox (command_id,thread_id,run_id,kind,command) VALUES ($1,$2,$3,'start',$4)",
    [ids.command, ids.thread, ids.run, command],
  )
}

async function uppercaseCommandHeaders(db: Client) {
  await db.query(`
    UPDATE product.command_outbox SET command =
      jsonb_set(jsonb_set(jsonb_set(jsonb_set(command,
        '{threadID}', to_jsonb(upper(thread_id::text))),
        '{runID}', to_jsonb(upper(run_id::text))),
        '{commandID}', to_jsonb(upper(command_id::text))),
        '{input,messageID}', to_jsonb(upper(message_id::text)))
  `)
}

test('asset migration preserves ready and pending files, old keys, links and exact accepted inputs', async () => {
  const fixture = await legacyDatabase()
  try {
    const file = {
      materialID: ids.asset,
      name: 'source.txt',
      mimeType: 'text/plain',
      byteLength: 3,
      sha256: 'a'.repeat(64),
      objectKey: `materials/${ids.thread}/${ids.asset}`,
    }
    await fixture.db.query(
      'INSERT INTO product.materials (material_id,thread_id,name,mime_type,byte_length,sha256,object_key,completed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,now())',
      [
        ids.asset,
        ids.thread,
        file.name,
        file.mimeType,
        file.byteLength,
        file.sha256,
        file.objectKey,
      ],
    )
    const pendingID = crypto.randomUUID()
    await fixture.db.query(
      "INSERT INTO product.materials (material_id,thread_id,name,mime_type,byte_length,sha256,object_key) VALUES ($1,$2,'pending.txt','text/plain',3,$3,$4)",
      [
        pendingID,
        ids.thread,
        file.sha256,
        `materials/${ids.thread}/${pendingID}`,
      ],
    )
    await fixture.db.query(
      'INSERT INTO product.message_materials VALUES ($1,$2,$3,0)',
      [ids.thread, ids.message, ids.asset],
    )
    await seedCommand(fixture.db, [file])
    expect(await fixture.upgrade()).toBe(0)
    const assets = await fixture.db.query<{
      asset_id: string
      object_key: string
      ready: boolean
    }>(
      'SELECT asset_id,object_key,ready_at IS NOT NULL AS ready FROM product.assets ORDER BY ready DESC',
    )
    expect(assets.rows).toEqual([
      { asset_id: ids.asset, object_key: file.objectKey, ready: true },
      {
        asset_id: pendingID,
        object_key: `materials/${ids.thread}/${pendingID}`,
        ready: false,
      },
    ])
    const links = await fixture.db.query<{
      asset_id: string
      position: number
    }>('SELECT asset_id,position FROM product.message_assets')
    expect(links.rows).toEqual([{ asset_id: ids.asset, position: 0 }])
    const commands = await fixture.db.query<{ command: unknown }>(
      'SELECT command FROM product.command_outbox UNION ALL SELECT command FROM execution.command_inbox',
    )
    const { materialID, ...reference } = file
    for (const row of commands.rows) {
      const command = executionCommandSchema.parse(row.command)
      expect(command).toEqual({
        version: 1,
        kind: 'start',
        commandID: ids.command,
        threadID: ids.thread,
        runID: ids.run,
        input: {
          messageID: ids.message,
          text: 'Historical input',
          assets: [{ assetID: materialID, ...reference }],
        },
      })
    }
  } finally {
    await fixture.close()
  }
}, 30000)

test('asset migration preserves a historical text input with an explicitly empty material list', async () => {
  const fixture = await legacyDatabase()
  try {
    await seedCommand(fixture.db, [])
    expect(await fixture.upgrade()).toBe(0)
    const commands = await fixture.db.query<{ command: unknown }>(
      'SELECT command FROM product.command_outbox UNION ALL SELECT command FROM execution.command_inbox',
    )
    for (const row of commands.rows) {
      const command = executionCommandSchema.parse(row.command)
      expect(command).toEqual({
        version: 1,
        kind: 'start',
        commandID: ids.command,
        threadID: ids.thread,
        runID: ids.run,
        input: { messageID: ids.message, text: 'Historical input' },
      })
    }
  } finally {
    await fixture.close()
  }
}, 30000)

test('native migration retains historical archive identity and history behind an explicit recovery gate', async () => {
  const fixture = await legacyDatabase()
  const checkpoint = {
    objectKey: `workspaces/${ids.thread}/historical-checkpoint`,
    byteLength: 123,
    sha256: 'c'.repeat(64),
  }
  const history = [{ role: 'user', content: 'Historical private context' }]
  try {
    await fixture.db.query(
      'INSERT INTO execution.conversations (thread_id,history,workspace_checkpoint) VALUES ($1,$2,$3)',
      [ids.thread, JSON.stringify(history), checkpoint],
    )
    expect(await fixture.upgrade('20261004050000_native_sandbox.sql')).toBe(0)
    const row = await fixture.db.query<{
      history: unknown
      legacy_workspace_checkpoint: unknown
      native_sandbox: unknown
      sandbox_recovery_required: boolean
    }>(
      'SELECT history,legacy_workspace_checkpoint,native_sandbox,sandbox_recovery_required FROM execution.conversations WHERE thread_id=$1',
      [ids.thread],
    )
    expect(row.rows).toEqual([
      {
        history,
        legacy_workspace_checkpoint: checkpoint,
        native_sandbox: null,
        sandbox_recovery_required: true,
      },
    ])
  } finally {
    await fixture.close()
  }
}, 30000)

test('asset migration rejects colliding old namespaces without losing either file identity', async () => {
  const fixture = await legacyDatabase()
  try {
    const digest = 'b'.repeat(64)
    await fixture.db.query(
      "INSERT INTO product.materials (material_id,thread_id,name,mime_type,byte_length,sha256,object_key) VALUES ($1,$2,'input.txt','text/plain',3,$3,$4)",
      [ids.asset, ids.thread, digest, `materials/${ids.thread}/${ids.asset}`],
    )
    await fixture.db.query(
      "INSERT INTO product.artifacts (artifact_id,thread_id,run_id,message_id,name,mime_type,byte_length,sha256,object_key) VALUES ($1,$2,$3,$4,'output.txt','text/plain',3,$5,$6)",
      [
        ids.asset,
        ids.thread,
        ids.run,
        ids.assistant,
        digest,
        `artifacts/${ids.thread}/${ids.run}/1/${ids.asset}`,
      ],
    )
    expect(await fixture.upgrade()).not.toBe(0)
    const counts = await fixture.db.query<{
      materials: number
      artifacts: number
    }>(
      'SELECT (SELECT count(*)::int FROM product.materials) AS materials,(SELECT count(*)::int FROM product.artifacts) AS artifacts',
    )
    expect(counts.rows).toEqual([{ materials: 1, artifacts: 1 }])
  } finally {
    await fixture.close()
  }
}, 30000)

test.each([
  { uppercase: false, byteLength: 3 },
  { uppercase: true, byteLength: 3 },
  { uppercase: false, byteLength: 10 * 1024 * 1024 },
  { uppercase: true, byteLength: 10 * 1024 * 1024 },
])(
  'unaccepted historical completion survives dbmate upgrade: %j',
  async ({ uppercase, byteLength }) => {
    const fixture = await legacyDatabase()
    const product = new Kysely<DB>({
      dialect: new PostgresDialect({
        pool: new Pool({ connectionString: fixture.url }),
      }),
    })
    try {
      await seedCommand(fixture.db, [])
      if (uppercase) await uppercaseCommandHeaders(fixture.db)
      await fixture.db.query(
        'INSERT INTO execution.conversations (thread_id) VALUES ($1)',
        [ids.thread],
      )
      await fixture.db.query(
        'INSERT INTO execution.runs (run_id,thread_id,command_id,message_id,text) VALUES ($1,$2,$3,$4,$5)',
        [ids.run, ids.thread, ids.command, ids.message, 'Historical input'],
      )
      const eventID = crypto.randomUUID()
      const messageID = crypto.randomUUID()
      const key = `artifacts/${ids.thread}/${ids.run}/7/${ids.asset}`
      const secondAssetID = crypto.randomUUID()
      const secondKey = `artifacts/${ids.thread}/${ids.run}/7/${secondAssetID}`
      await fixture.db.query(
        'INSERT INTO execution.event_outbox (event_id,thread_id,run_id,ordinal,event) VALUES ($1,$2,$3,1,$4)',
        [
          eventID,
          ids.thread,
          ids.run,
          {
            version: 1,
            kind: 'run-completed',
            eventID,
            threadID: ids.thread,
            runID: ids.run,
            messageID,
            text: 'Retained output',
            artifacts: [
              {
                artifactID: ids.asset,
                name: 'result.txt',
                mimeType: 'text/plain',
                byteLength,
                sha256: 'a'.repeat(64),
                objectKey: key,
              },
              {
                artifactID: secondAssetID,
                name: 'second.txt',
                mimeType: 'text/plain',
                byteLength,
                sha256: 'b'.repeat(64),
                objectKey: secondKey,
              },
            ],
          },
        ],
      )
      expect(await fixture.upgrade()).toBe(0)
      const header = await fixture.db.query<{ command: unknown }>(
        'SELECT command FROM product.command_outbox WHERE command_id=$1',
        [ids.command],
      )
      const expectedIDs = Object.fromEntries(
        Object.entries(ids).map(([name, id]) => [
          name,
          uppercase ? id.toUpperCase() : id,
        ]),
      )
      expect(header.rows[0]?.command).toMatchObject({
        threadID: expectedIDs.thread,
        runID: expectedIDs.run,
        commandID: expectedIDs.command,
        input: { messageID: expectedIDs.message },
      })
      const retained = await fixture.db.query<{
        event: unknown
        ordinal: number
      }>('SELECT event,ordinal FROM execution.event_outbox WHERE event_id=$1', [
        eventID,
      ])
      const delivery = executionDeliverySchema.parse(retained.rows[0])
      if (delivery.event.kind !== 'run-completed')
        throw new Error('Expected completion')
      const asset = delivery.event.assets?.[0]
      if (!asset) throw new Error('Missing migrated asset')
      for (const foreignKey of [
        `artifacts/${crypto.randomUUID()}/${ids.run}/7/${ids.asset}`,
        `artifacts/${ids.thread}/${crypto.randomUUID()}/7/${ids.asset}`,
        `artifacts/${ids.thread}/${ids.run}/7/${crypto.randomUUID()}`,
        `artifacts/${ids.thread}/${ids.run}/0/${ids.asset}`,
      ]) {
        expect(
          await acceptExecutionEvent(product, {
            ...delivery,
            event: {
              ...delivery.event,
              assets: [{ ...asset, objectKey: foreignKey }],
            },
          }),
        ).toBe('conflict')
      }
      const currentID = crypto.randomUUID()
      const current = {
        ...asset,
        assetID: currentID,
        byteLength: 8 * 1024 * 1024,
        objectKey: `assets/generated/${ids.thread}/${ids.run}/7/${currentID}`,
      }
      const extraID = crypto.randomUUID()
      const extra = {
        ...current,
        assetID: extraID,
        byteLength: 1,
        objectKey: `assets/generated/${ids.thread}/${ids.run}/7/${extraID}`,
      }
      for (const rejected of [
        [current, extra],
        [asset, current, extra],
        [{ ...asset, byteLength: 16 * 1024 * 1024 + 1 }],
        [{ ...asset, name: '../bad.txt' }],
        [{ ...current, name: '../bad.txt' }],
        [{ ...current, objectKey: current.objectKey.replace('/7/', '/0/') }],
        [
          {
            ...current,
            objectKey: current.objectKey.replace(ids.run, crypto.randomUUID()),
          },
        ],
        [
          {
            ...current,
            objectKey: current.objectKey.replace(
              currentID,
              crypto.randomUUID(),
            ),
          },
        ],
      ])
        expect(
          await acceptExecutionEvent(product, {
            ...delivery,
            event: { ...delivery.event, assets: rejected },
          }),
        ).toBe('conflict')
      expect(await acceptExecutionEvent(product, delivery)).toBe('accepted')
      expect(await acceptExecutionEvent(product, delivery)).toBe('accepted')
      const stored = await product
        .selectFrom('product.assets')
        .selectAll()
        .where('asset_id', '=', ids.asset)
        .executeTakeFirstOrThrow()
      expect(stored.object_key).toBe(key)
      expect(stored.byte_length).toBe(byteLength)
      const second = await product
        .selectFrom('product.assets')
        .selectAll()
        .where('asset_id', '=', secondAssetID)
        .executeTakeFirstOrThrow()
      expect(second.object_key).toBe(secondKey)
      expect(second.byte_length).toBe(byteLength)
      expect(stored.message_id).toBe(messageID)
      expect(stored.ready_at).not.toBeNull()
      expect(
        await product
          .selectFrom('product.message_assets')
          .select('asset_id')
          .where('message_id', '=', messageID)
          .orderBy('position')
          .execute(),
      ).toEqual([{ asset_id: ids.asset }, { asset_id: secondAssetID }])
    } finally {
      await product.destroy()
      await fixture.close()
    }
  },
  30000,
)

test('retained uppercase legacy start authorizes migrated failure and owned failed-run snapshot', async () => {
  const fixture = await legacyDatabase()
  const product = new Kysely<DB>({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString: fixture.url }),
    }),
  })
  try {
    await seedCommand(fixture.db, [])
    await uppercaseCommandHeaders(fixture.db)
    await fixture.db.query(
      'INSERT INTO execution.conversations (thread_id) VALUES ($1)',
      [ids.thread],
    )
    await fixture.db.query(
      'INSERT INTO execution.runs (run_id,thread_id,command_id,message_id,text) VALUES ($1,$2,$3,$4,$5)',
      [ids.run, ids.thread, ids.command, ids.message, 'Historical input'],
    )
    const eventID = crypto.randomUUID()
    await fixture.db.query(
      'INSERT INTO execution.event_outbox (event_id,thread_id,run_id,ordinal,event) VALUES ($1,$2,$3,2,$4)',
      [
        eventID,
        ids.thread,
        ids.run,
        {
          version: 1,
          kind: 'run-failed',
          eventID,
          threadID: ids.thread,
          runID: ids.run,
          reason: 'execution-error',
        },
      ],
    )
    expect(await fixture.upgrade()).toBe(0)
    const retained = await fixture.db.query<{
      event: unknown
      ordinal: number
    }>('SELECT event,ordinal FROM execution.event_outbox WHERE event_id=$1', [
      eventID,
    ])
    const delivery = executionDeliverySchema.parse(retained.rows[0])
    expect(await acceptExecutionEvent(product, delivery)).toBe('accepted')
    expect(
      await snapshotOwnedMessages(product, {
        ownerID: 'migration-user',
        threadID: ids.thread,
      }),
    ).toMatchObject({
      activeRuns: [],
      failedRuns: [
        { runID: ids.run, messageID: ids.message, reason: 'execution-error' },
      ],
    })
    expect(
      await snapshotOwnedMessages(product, {
        ownerID: 'foreign-user',
        threadID: ids.thread,
      }),
    ).toBeNull()
  } finally {
    await product.destroy()
    await fixture.close()
  }
}, 30000)
