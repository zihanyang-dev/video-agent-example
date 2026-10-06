import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { Client } from 'pg'
import { readMigrationEnv } from '@vid/config'
import {
  openTestDatabase,
  testDatabaseOptions,
  verifyTestDatabase,
  settleTestCleanup,
} from './database-fixture'
import { acceptExecutionCommand } from '../../apps/agent/src/db/command-acceptance'
import {
  claimExecutionRun,
  renewExecutionLease,
} from '../../apps/agent/src/db/execution-leases'
import {
  appendExecutionText,
  completeExecutionRun,
  quarantineSandbox,
  saveNativeSandbox,
} from '../../apps/agent/src/db/run-writes'

const migration =
  'packages/database/migrations/20261006000000_relational_integrity.sql'
const id = () => crypto.randomUUID()

async function fixture(
  body: (db: Client, ids: ReturnType<typeof identities>) => Promise<void>,
) {
  const db = new Client(testDatabaseOptions(readMigrationEnv().DATABASE_URL))
  let transactionOpened = false
  try {
    await db.connect()
    await verifyTestDatabase(db)
    await db.query('BEGIN')
    transactionOpened = true
    const ids = identities()
    await db.query(
      `INSERT INTO auth."user" (id,name,email,"emailVerified") VALUES ($1,'Integrity',$2,true)`,
      [ids.owner, `${ids.owner}@fixture.invalid`],
    )
    await db.query(
      'INSERT INTO product.threads (thread_id,owner_id) VALUES ($1,$3),($2,$3)',
      [ids.a, ids.b, ids.owner],
    )
    await db.query(
      "INSERT INTO product.messages (thread_id,message_id,role,text) VALUES ($1,$2,'user','Historical input')",
      [ids.a, ids.message],
    )
    await db.query(
      'INSERT INTO execution.conversations (thread_id) VALUES ($1),($2)',
      [ids.a, ids.b],
    )
    await db.query(
      "INSERT INTO execution.command_inbox (command_id,thread_id,run_id,kind,command) VALUES ($1,$2,$3,'start',$4)",
      [
        ids.command,
        ids.a,
        ids.run,
        {
          threadID: ids.a.toUpperCase(),
          materials: [],
          historical: 'untouched',
        },
      ],
    )
    await db.query(
      "INSERT INTO execution.runs (run_id,thread_id,command_id,message_id,text) VALUES ($1,$2,$3,$4,'Historical input')",
      [ids.run, ids.a, ids.command, ids.message],
    )
    await body(db, ids)
  } finally {
    await settleTestCleanup([
      async () => {
        if (transactionOpened) await db.query('ROLLBACK')
      },
      () => db.end(),
    ])
  }
}

function identities() {
  return {
    owner: id(),
    a: id(),
    b: id(),
    message: id(),
    command: id(),
    run: id(),
  }
}

async function rejects(
  db: Client,
  query: string,
  values: unknown[],
  constraint: string,
) {
  await db.query('SAVEPOINT invalid_write')
  try {
    const error = await db.query(query, values).then(
      () => null,
      (cause: unknown) => cause,
    )
    expect(error).toMatchObject({ code: '23503', constraint })
  } finally {
    await db.query('ROLLBACK TO SAVEPOINT invalid_write')
  }
}

test('same-schema references admit claim, terminal release, cancellation and explicit delete order', async () => {
  await fixture(async (db, ids) => {
    await db.query(
      'INSERT INTO product.command_outbox (command_id,thread_id,run_id,message_id,command) VALUES ($1,$2,$3,$4,$5)',
      [
        ids.command,
        ids.a,
        ids.run,
        ids.message,
        { threadID: ids.a.toUpperCase(), materials: [] },
      ],
    )
    // Cancel commands need no message and may precede a run.
    await db.query(
      'INSERT INTO product.command_outbox (command_id,thread_id,run_id,command) VALUES ($1,$2,$3,$4)',
      [id(), ids.b, id(), { kind: 'cancel' }],
    )
    await db.query(
      "UPDATE execution.conversations SET active_run_id=$1,lease_owner='worker',lease_until=now()+interval '1 minute',fence=1,native_sandbox=$3,sandbox_recovery_required=true WHERE thread_id=$2",
      [ids.run, ids.a, { provider: 'e2b', id: 'Native/UPPER', retained: true }],
    )
    await db.query(
      "UPDATE execution.runs SET status='running' WHERE run_id=$1",
      [ids.run],
    )
    await db.query(
      'INSERT INTO execution.event_outbox (event_id,thread_id,run_id,ordinal,event) VALUES ($1,$2,$3,1,$4)',
      [id(), ids.a, ids.run, { kind: 'run-started' }],
    )
    await db.query('DELETE FROM execution.event_outbox WHERE run_id=$1', [
      ids.run,
    ])
    await rejects(
      db,
      'DELETE FROM execution.runs WHERE run_id=$1',
      [ids.run],
      'conversations_active_run_identity',
    )
    await db.query(
      "UPDATE execution.runs SET status='failed' WHERE run_id=$1",
      [ids.run],
    )
    await db.query(
      'UPDATE execution.conversations SET active_run_id=null,lease_owner=null,lease_until=null WHERE thread_id=$1',
      [ids.a],
    )
    const retained = (
      await db.query(
        'SELECT native_sandbox,sandbox_recovery_required FROM execution.conversations WHERE thread_id=$1',
        [ids.a],
      )
    ).rows[0]
    expect(retained).toEqual({
      native_sandbox: { provider: 'e2b', id: 'Native/UPPER', retained: true },
      sandbox_recovery_required: true,
    })
    await db.query('DELETE FROM execution.event_outbox WHERE run_id=$1', [
      ids.run,
    ])
    await db.query('DELETE FROM execution.runs WHERE run_id=$1', [ids.run])
    await db.query('DELETE FROM execution.conversations WHERE thread_id=$1', [
      ids.a,
    ])
    await db.query('DELETE FROM execution.command_inbox WHERE command_id=$1', [
      ids.command,
    ])
  })
})

const invalid = [
  [
    'product message thread',
    "INSERT INTO product.command_outbox (command_id,thread_id,run_id,message_id,command) VALUES ($1,$2,$3,$4,'{}')",
    (ids: ReturnType<typeof identities>) => [id(), ids.b, ids.run, ids.message],
    'command_outbox_message_identity',
  ],
  [
    'run command thread',
    'UPDATE execution.runs SET thread_id=$1 WHERE run_id=$2',
    (ids: ReturnType<typeof identities>) => [ids.b, ids.run],
    'runs_command_identity',
  ],
  [
    'run command native ID',
    'UPDATE execution.runs SET run_id=$1 WHERE run_id=$2',
    (ids: ReturnType<typeof identities>) => [id(), ids.run],
    'runs_command_identity',
  ],
  [
    'event run thread',
    "INSERT INTO execution.event_outbox (event_id,thread_id,run_id,ordinal,event) VALUES ($1,$2,$3,1,'{}')",
    (ids: ReturnType<typeof identities>) => [id(), ids.b, ids.run],
    'event_outbox_run_identity',
  ],
  [
    'active run other thread',
    "UPDATE execution.conversations SET active_run_id=$1,lease_owner='worker',lease_until=now() WHERE thread_id=$2",
    (ids: ReturnType<typeof identities>) => [ids.run, ids.b],
    'conversations_active_run_identity',
  ],
  [
    'active run missing native ID',
    "UPDATE execution.conversations SET active_run_id=$1,lease_owner='worker',lease_until=now() WHERE thread_id=$2",
    (ids: ReturnType<typeof identities>) => [id(), ids.a],
    'conversations_active_run_identity',
  ],
] as const

for (const [name, query, values, constraint] of invalid) {
  test(`rejects ${name}`, async () => {
    await fixture(
      async (db, ids) => await rejects(db, query, values(ids), constraint),
    )
  })
}

test('forward validation fails on every retained inconsistency without rewriting retained evidence', async () => {
  const text = await readFile(migration, 'utf8')
  const [up, down] = text.split('-- migrate:down')
  if (!up || !down) throw new Error('Expected reversible migration')
  for (const [, query, values, constraint] of invalid) {
    await fixture(async (db, ids) => {
      // Transaction-local rollback to the predecessor constraints: no global fixture changes.
      await db.query(down)
      await db.query(query, values(ids))
      const before = (
        await db.query(
          'SELECT command FROM execution.command_inbox WHERE command_id=$1',
          [ids.command],
        )
      ).rows
      await rejects(db, up, [], constraint)
      expect(
        (
          await db.query(
            'SELECT command FROM execution.command_inbox WHERE command_id=$1',
            [ids.command],
          )
        ).rows,
      ).toEqual(before)
    })
  }
})

test('valid retained uppercase JSON, legacy checkpoint and unknown recovery survive forward migration exactly', async () => {
  const text = await readFile(migration, 'utf8')
  const [up, down] = text.split('-- migrate:down')
  if (!up || !down) throw new Error('Expected reversible migration')
  await fixture(async (db, ids) => {
    await db.query(down)
    await db.query(
      "UPDATE execution.conversations SET active_run_id=$1,lease_owner='UNKNOWN/worker',lease_until=now(),native_sandbox=$3,legacy_workspace_checkpoint=$4,sandbox_recovery_required=true WHERE thread_id=$2",
      [
        ids.run,
        ids.a,
        { provider: 'E2B', id: 'Native/UPPER' },
        { archive: 'Historical/UPPER', digest: 'retained' },
      ],
    )
    const snapshot = async () =>
      (
        await db.query(
          `SELECT row_to_json(c) AS conversation, row_to_json(i) AS inbox, row_to_json(r) AS run FROM execution.conversations c JOIN execution.runs r USING(thread_id) JOIN execution.command_inbox i USING(command_id) WHERE c.thread_id=$1`,
          [ids.a],
        )
      ).rows
    const before = await snapshot()
    await db.query(up)
    expect(await snapshot()).toEqual(before)
    await db.query('SAVEPOINT partial_release')
    try {
      const error = await db
        .query(
          'UPDATE execution.conversations SET active_run_id=null WHERE thread_id=$1',
          [ids.a],
        )
        .then(
          () => null,
          (cause: unknown) => cause,
        )
      expect(error).toMatchObject({
        code: '23514',
        constraint: 'conversations_check',
      })
    } finally {
      await db.query('ROLLBACK TO SAVEPOINT partial_release')
    }
  })
})

test('actual execution admission, replay, claim, renewal, completion and quarantine remain admitted', async () => {
  const { db, close } = openTestDatabase()
  const ids = identities()
  const command = {
    version: 1 as const,
    kind: 'start' as const,
    commandID: ids.command,
    threadID: ids.a,
    runID: ids.run,
    input: { messageID: ids.message, text: 'Integrity lifecycle' },
  }
  try {
    expect(await acceptExecutionCommand(db, command)).toBe('accepted')
    expect(await acceptExecutionCommand(db, command)).toBe('replay')
    await db.transaction().execute(async (scheduling) => {
      // The real scheduler is global. Keep unrelated retained recovery fixtures
      // locked, without changing their rows or claiming their execution authority.
      await scheduling
        .selectFrom('execution.conversations')
        .select('thread_id')
        .where('thread_id', '!=', ids.a)
        .forUpdate()
        .execute()
      const lease = await claimExecutionRun(db, {
        ownerID: ids.owner,
        leaseMs: 30000,
      })
      if (!lease) throw new Error('Expected lease')
      expect(lease.runID).toBe(ids.run)
      expect(await renewExecutionLease(db, lease, 30000)).toBe('renewed')
      expect(
        await saveNativeSandbox(db, lease, {
          provider: 'e2b',
          id: 'Native/UPPER',
        }),
      ).toBe(true)
      expect(await appendExecutionText(db, lease, 'done')).toBe(true)
      expect(
        await completeExecutionRun(db, lease, { text: 'done', history: [] }),
      ).toBe(true)
      const next = { ...command, commandID: id(), runID: id() }
      expect(await acceptExecutionCommand(db, next)).toBe('accepted')
      const unknown = await claimExecutionRun(db, {
        ownerID: ids.owner,
        leaseMs: 30000,
      })
      if (!unknown) throw new Error('Expected next lease')
      await quarantineSandbox(db, unknown)
      const retained = await db
        .selectFrom('execution.conversations')
        .select([
          'active_run_id',
          'lease_owner',
          'lease_until',
          'native_sandbox',
          'sandbox_recovery_required',
        ])
        .where('thread_id', '=', ids.a)
        .executeTakeFirstOrThrow()
      expect(retained).toEqual({
        active_run_id: null,
        lease_owner: null,
        lease_until: null,
        native_sandbox: { provider: 'e2b', id: 'Native/UPPER' },
        sandbox_recovery_required: true,
      })
    })
  } finally {
    try {
      await db.transaction().execute(async (tx) => {
        await tx
          .updateTable('execution.conversations')
          .set({ active_run_id: null, lease_owner: null, lease_until: null })
          .where('thread_id', '=', ids.a)
          .execute()
        await tx
          .deleteFrom('execution.event_outbox')
          .where('thread_id', '=', ids.a)
          .execute()
        await tx
          .deleteFrom('execution.runs')
          .where('thread_id', '=', ids.a)
          .execute()
        await tx
          .deleteFrom('execution.conversations')
          .where('thread_id', '=', ids.a)
          .execute()
        await tx
          .deleteFrom('execution.command_inbox')
          .where('thread_id', '=', ids.a)
          .execute()
      })
    } finally {
      await close()
    }
  }
})
