import { expect, test } from 'bun:test'
import pg from 'pg'
import { createClient } from 'redis'

const serverURL = process.env.SERVER_DATABASE_URL!
const workerURL = process.env.WORKER_DATABASE_URL!

test('runtime SQL roles can mutate their own schema but cannot read or mutate the other schema', async () => {
  for (const [url, own, other] of [
    [serverURL, 'product', 'execution'],
    [workerURL, 'execution', 'product'],
  ] as const) {
    await checkSQLRole(url, own, other)
  }
})

async function denied(promise: Promise<unknown>, expected: Record<string, unknown>) {
  expect(await promise.catch((error: unknown) => error)).toMatchObject(expected)
}

async function checkSQLRole(url: string, own: string, other: string) {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    await checkOwnedMutation(client, own)
    await client.query(
      `SELECT * FROM ${own}.command_${own === 'product' ? 'outbox' : 'inbox'} LIMIT 1`,
    )
    await client.query(
      `UPDATE ${own}.command_${own === 'product' ? 'outbox' : 'inbox'} SET command_id = command_id WHERE false`,
    )
    for (const statement of [
      `SELECT * FROM ${other}.command_${other === 'product' ? 'outbox' : 'inbox'}`,
      `DELETE FROM ${other}.command_${other === 'product' ? 'outbox' : 'inbox'}`,
      `CREATE TABLE ${own}.forbidden (id int)`,
      'CREATE SCHEMA forbidden',
    ]) {
      await denied(client.query(statement), { code: '42501' })
    }
    if (own === 'execution') {
      await denied(client.query("SELECT nextval('product.execution_event_replay_cursor')"), {
        code: '42501',
      })
      await denied(client.query('SELECT payload FROM product.execution_events'), { code: '42501' })
    }
    const result = await client.query(
      'SELECT rolsuper, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = current_user',
    )
    expect(result.rows[0]).toEqual({
      rolsuper: false,
      rolcreaterole: false,
      rolcreatedb: false,
    })
  } finally {
    await client.end()
  }
}

async function checkOwnedMutation(client: pg.Client, own: string) {
  await client.query('BEGIN')
  try {
    const id = crypto.randomUUID()
    if (own === 'product') {
      await client.query(
        'INSERT INTO auth."user" (id, name, email, "emailVerified") VALUES ($1, $2, $3, true)',
        [id, 'Boundary fixture', `${id}@boundary.example.test`],
      )
      await client.query('INSERT INTO product.threads (thread_id, owner_id) VALUES ($1, $2)', [
        id,
        id,
      ])
      await client.query("SELECT nextval('product.execution_event_replay_cursor')")
    } else {
      await client.query('INSERT INTO execution.conversations (thread_id) VALUES ($1)', [id])
    }
  } finally {
    await client.query('ROLLBACK')
  }
}

test('authentication storage belongs to the server and remains private from workers', async () => {
  const server = new pg.Client({ connectionString: serverURL })
  const worker = new pg.Client({ connectionString: workerURL })
  await Promise.all([server.connect(), worker.connect()])
  try {
    await server.query('BEGIN')
    const userID = crypto.randomUUID()
    await server.query(
      'INSERT INTO auth."user" (id, name, email, "emailVerified") VALUES ($1, $2, $3, true)',
      [userID, 'Boundary fixture', `${userID}@boundary.example.test`],
    )
    await server.query(
      'INSERT INTO auth.session (id, token, "expiresAt", "updatedAt", "userId") VALUES ($1, $2, now() + interval \'1 hour\', now(), $3)',
      [crypto.randomUUID(), crypto.randomUUID(), userID],
    )
    await server.query('ROLLBACK')
    for (const statement of [
      'SELECT * FROM auth."user"',
      'DELETE FROM auth."user"',
      'SELECT * FROM auth.session',
      'DELETE FROM auth.session',
      'SELECT * FROM auth.account',
      'DELETE FROM auth.account',
      'SELECT * FROM auth.verification',
      'DELETE FROM auth.verification',
    ])
      await denied(worker.query(statement), { code: '42501' })
    await denied(server.query('CREATE TABLE auth.forbidden (id int)'), {
      code: '42501',
    })
  } finally {
    await Promise.all([server.end(), worker.end()])
  }
})

test('native reapplication repairs current and future grants for the migration owner', async () => {
  const server = new pg.Client({ connectionString: serverURL })
  const worker = new pg.Client({ connectionString: workerURL })
  await Promise.all([server.connect(), worker.connect()])
  try {
    await server.query('INSERT INTO auth.boundary_future_table (id) VALUES (1)')
    await worker.query('INSERT INTO execution.boundary_future_table (id) VALUES (1)')
    await denied(server.query('TRUNCATE auth.boundary_existing_table'), {
      code: '42501',
    })
    await denied(worker.query('TRUNCATE execution.boundary_existing_table'), {
      code: '42501',
    })
    for (const table of ['boundary_existing_table', 'boundary_future_table']) {
      await denied(worker.query(`SELECT * FROM auth.${table}`), {
        code: '42501',
      })
      await denied(server.query(`SELECT * FROM execution.${table}`), {
        code: '42501',
      })
    }
  } finally {
    await Promise.all([server.end(), worker.end()])
  }
})

test('Redis runtime ACL permits owned publishing and peer consumption but denies cross-role publishing and administration', async () => {
  // The launcher installs the production ACL before starting its isolated Redis.
  for (const [url, own, other] of [
    [process.env.SERVER_REDIS_URL!, 'commands', 'events'],
    [process.env.WORKER_REDIS_URL!, 'events', 'commands'],
  ] as const) {
    const client = createClient({ url })
    await client.connect()
    try {
      await client.xAdd(`vid:execution:${own}`, '*', { value: 'test' })
      await client.xGroupCreate(`vid:execution:${other}`, 'boundary-test', '0', { MKSTREAM: true })
      await client.xReadGroup('boundary-test', 'test', {
        key: `vid:execution:${other}`,
        id: '>',
      })
      await client.xAutoClaim(`vid:execution:${other}`, 'boundary-test', 'test', 0, '0-0')
      await client.xAck(`vid:execution:${other}`, 'boundary-test', '0-0')
      await denied(client.xGroupCreate(`vid:execution:${own}`, 'forbidden', '0'), {
        message: expect.stringContaining('NOPERM'),
      })
      await denied(client.xAdd(`vid:execution:${other}`, '*', { value: 'forbidden' }), {
        message: expect.stringContaining('NOPERM'),
      })
      await denied(client.set('unrelated', 'forbidden'), {
        message: expect.stringContaining('NOPERM'),
      })
      await denied(client.flushAll(), {
        message: expect.stringContaining('NOPERM'),
      })
      await denied(client.xTrim(`vid:execution:${own}`, 'MAXLEN', 0), {
        message: expect.stringContaining('NOPERM'),
      })
      await denied(client.sendCommand(['CONFIG', 'SET', 'appendonly', 'no']), {
        message: expect.stringContaining('NOPERM'),
      })
    } finally {
      client.destroy()
    }
  }
})

test('native password rotation rejects the previous credentials', async () => {
  for (const url of [process.env.OLD_SERVER_DATABASE_URL!, process.env.OLD_WORKER_DATABASE_URL!]) {
    const client = new pg.Client({ connectionString: url })
    try {
      await denied(client.connect(), { code: '28P01' })
    } finally {
      await client.end()
    }
  }
})

async function storageRole(role: 'SERVER' | 'WORKER', secret?: string) {
  const { S3Client } = await import('@aws-sdk/client-s3')
  return new S3Client({
    endpoint: process.env.STORAGE_TEST_ENDPOINT!,
    region: 'us-east-1',
    forcePathStyle: true,
    maxAttempts: 1,
    credentials: {
      accessKeyId: process.env[`STORAGE_${role}_ACCESS_KEY`]!,
      secretAccessKey: secret ?? process.env[`STORAGE_${role}_SECRET_KEY`]!,
    },
  })
}

for (const role of ['SERVER', 'WORKER'] as const) {
  test(`S3 asset ${role} can publish only its owned prefix`, async () => {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3')
    const Bucket = process.env.OBJECT_STORAGE_BUCKET!
    const client = await storageRole(role)
    try {
      const own = role === 'SERVER' ? 'uploads' : 'generated'
      await client.send(
        new PutObjectCommand({
          Bucket,
          Key: `assets/${own}/boundary`,
          Body: own,
        }),
      )
      for (const Key of [
        `assets/${own === 'uploads' ? 'generated' : 'uploads'}/forbidden`,
        'materials/boundary',
        'artifacts/boundary',
        'workspaces/forbidden',
      ]) {
        await denied(client.send(new PutObjectCommand({ Bucket, Key, Body: 'forbidden' })), {
          name: 'AccessDenied',
        })
      }
    } finally {
      client.destroy()
    }
  })
}

for (const role of ['SERVER', 'WORKER'] as const) {
  test(`S3 retained ${role} reads historical and new keys without listing, deletion or administration`, async () => {
    const { GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command, CreateBucketCommand } =
      await import('@aws-sdk/client-s3')
    const Bucket = process.env.OBJECT_STORAGE_BUCKET!
    const client = await storageRole(role)
    try {
      for (const [Key, body] of [
        ['assets/uploads/boundary', 'uploads'],
        ['assets/generated/boundary', 'generated'],
        ['materials/boundary', 'legacy-upload'],
        ['artifacts/boundary', 'legacy-output'],
      ] as const) {
        const response = await client.send(new GetObjectCommand({ Bucket, Key }))
        expect(await response.Body!.transformToString()).toBe(body)
        await denied(client.send(new DeleteObjectCommand({ Bucket, Key })), {
          name: 'AccessDenied',
        })
      }
      await denied(client.send(new ListObjectsV2Command({ Bucket })), {
        name: 'AccessDenied',
      })
      await denied(client.send(new CreateBucketCommand({ Bucket: 'forbidden-bucket' })), {
        name: 'AccessDenied',
      })
    } finally {
      client.destroy()
    }
  })
}

test('S3 password rotation rejects previous secrets', async () => {
  const { GetObjectCommand } = await import('@aws-sdk/client-s3')
  for (const role of ['SERVER', 'WORKER'] as const) {
    const client = await storageRole(role, process.env[`OLD_STORAGE_${role}_SECRET_KEY`]!)
    try {
      await denied(
        client.send(
          new GetObjectCommand({
            Bucket: process.env.OBJECT_STORAGE_BUCKET!,
            Key: 'materials/boundary',
          }),
        ),
        { name: 'SignatureDoesNotMatch' },
      )
    } finally {
      client.destroy()
    }
  }
})
