import { expect, test } from 'bun:test'
import {
  readEgressEnv,
  readMigrationEnv,
  readServerEnv,
  readWorkerEnv,
} from './env'

const connections = {
  DATABASE_URL: 'postgresql://app:secret@postgres/app',
  REDIS_URL: 'redis://redis:6379',
}
const workerInput = {
  ...connections,
  MODEL_BASE_URL: 'https://model.example/v1',
  MODEL_API_KEY: 'test-model-secret',
  MODEL_ID: 'test-model',
  EGRESS_URL: 'http://egress:8080',
  SANDBOX_IMAGE: 'sandbox:test',
  SANDBOX_NETWORK: 'sandbox-egress',
  TURN_TOKEN_SECRET: 'x'.repeat(32),
}

function errorMessage(read: () => unknown): string {
  try {
    read()
  } catch (error) {
    if (error instanceof Error) return error.message
    throw error
  }
  throw new Error('Expected configuration to be rejected')
}

test('server strips unrelated secrets and defaults blank ports', () => {
  expect(
    readServerEnv({ ...workerInput, PORT: ' \t ', FAL_KEY: 'private' }),
  ).toEqual({
    ...connections,
    PORT: 8787,
  })
})

test('worker has complete execution configuration and no provider secrets', () => {
  expect(readWorkerEnv({ ...workerInput, FAL_KEY: 'private' })).toEqual({
    ...workerInput,
    LEASE_MS: 30000,
    POLL_MS: 200,
    CONCURRENCY: 3,
  })
})

test('egress needs only its signing secret and optional provider key', () => {
  expect(
    readEgressEnv({ TURN_TOKEN_SECRET: 'x'.repeat(32), FAL_KEY: '  ' }),
  ).toEqual({
    TURN_TOKEN_SECRET: 'x'.repeat(32),
    PORT: 8080,
    PROVIDER_ROUTES_PATH: '/app/config/providers.json',
  })
  expect(
    readEgressEnv({ ...workerInput, FAL_KEY: 'test-provider-secret' }),
  ).toEqual({
    TURN_TOKEN_SECRET: 'x'.repeat(32),
    FAL_KEY: 'test-provider-secret',
    PORT: 8080,
    PROVIDER_ROUTES_PATH: '/app/config/providers.json',
  })
})

test('migration requires only its database connection', () => {
  expect(readMigrationEnv(workerInput)).toEqual({
    DATABASE_URL: connections.DATABASE_URL,
  })
  expect(
    errorMessage(() => readMigrationEnv({ DATABASE_URL: '\n\t' })),
  ).toContain('DATABASE_URL')
})

test('each process reports all its missing required fields', () => {
  for (const [read, fields] of [
    [readServerEnv, ['DATABASE_URL', 'REDIS_URL']],
    [
      readWorkerEnv,
      [
        'DATABASE_URL',
        'REDIS_URL',
        'MODEL_BASE_URL',
        'MODEL_API_KEY',
        'MODEL_ID',
        'EGRESS_URL',
        'SANDBOX_IMAGE',
        'SANDBOX_NETWORK',
        'TURN_TOKEN_SECRET',
      ],
    ],
    [readEgressEnv, ['TURN_TOKEN_SECRET']],
  ] as const) {
    const message = errorMessage(() => read({}))
    for (const field of fields) expect(message).toContain(field)
  }
})

test('combined diagnostics never echo submitted credentials', () => {
  const message = errorMessage(() =>
    readWorkerEnv({
      ...workerInput,
      DATABASE_URL: ' ',
      REDIS_URL: '',
      MODEL_BASE_URL: 'ftp://user:URL-SECRET@model.example',
      MODEL_API_KEY: 'VALID-KEY-SECRET',
      TURN_TOKEN_SECRET: 'SHORT-SECRET',
      CONCURRENCY: 'INVALID-NUMBER-SECRET',
    }),
  )
  for (const field of [
    'DATABASE_URL',
    'REDIS_URL',
    'MODEL_BASE_URL',
    'TURN_TOKEN_SECRET',
    'CONCURRENCY',
  ]) {
    expect(message).toContain(field)
  }
  for (const secret of [
    'URL-SECRET',
    'VALID-KEY-SECRET',
    'SHORT-SECRET',
    'INVALID-NUMBER-SECRET',
  ]) {
    expect(message).not.toContain(secret)
  }
})

test('whitespace-only required worker values are missing', () => {
  for (const field of Object.keys(workerInput)) {
    expect(
      errorMessage(() => readWorkerEnv({ ...workerInput, [field]: ' \n\t ' })),
    ).toContain(field)
  }
})

test('endpoint URLs accept HTTP(S) and reject other schemes or malformed URLs', () => {
  for (const field of ['MODEL_BASE_URL', 'EGRESS_URL']) {
    for (const endpoint of [
      'ftp://host/path',
      'file:///tmp/model',
      'not-a-url',
    ]) {
      expect(
        errorMessage(() =>
          readWorkerEnv({ ...workerInput, [field]: endpoint }),
        ),
      ).toContain(field)
    }
    for (const endpoint of [
      'http://localhost:8080',
      'https://model.example/v1',
    ]) {
      expect(
        readWorkerEnv({ ...workerInput, [field]: endpoint })[
          field as 'MODEL_BASE_URL' | 'EGRESS_URL'
        ],
      ).toBe(endpoint)
    }
  }
})

test('database and Redis endpoints reject wrong protocols without leaking credentials', () => {
  for (const DATABASE_URL of ['https://user:private-password@db', 'invalid']) {
    const diagnostic = errorMessage(() => readMigrationEnv({ DATABASE_URL }))
    expect(diagnostic).toContain('DATABASE_URL')
    expect(diagnostic).not.toContain('private-password')
  }
  for (const REDIS_URL of ['https://user:private-password@redis', 'invalid']) {
    const diagnostic = errorMessage(() =>
      readServerEnv({ ...connections, REDIS_URL }),
    )
    expect(diagnostic).toContain('REDIS_URL')
    expect(diagnostic).not.toContain('private-password')
  }
  expect(
    readMigrationEnv({ DATABASE_URL: 'postgres://db/app' }).DATABASE_URL,
  ).toBe('postgres://db/app')
  expect(
    readServerEnv({ ...connections, REDIS_URL: 'rediss://redis:6379' })
      .REDIS_URL,
  ).toBe('rediss://redis:6379')
})

test('numeric settings reject zero, negatives, fractions and nonnumbers', () => {
  for (const field of ['LEASE_MS', 'POLL_MS', 'CONCURRENCY']) {
    for (const invalid of ['0', '-1', '1.5', 'NaN', 'Infinity', 'invalid']) {
      expect(
        errorMessage(() => readWorkerEnv({ ...workerInput, [field]: invalid })),
      ).toContain(field)
    }
  }
  for (const read of [readServerEnv, readEgressEnv]) {
    for (const PORT of ['0', '-1', '65536', '1.5', 'invalid']) {
      expect(errorMessage(() => read({ ...workerInput, PORT }))).toContain(
        'PORT',
      )
    }
    expect(read({ ...workerInput, PORT: '65535' }).PORT).toBe(65535)
  }
})

test('blank numeric values use worker defaults', () => {
  expect(
    readWorkerEnv({
      ...workerInput,
      LEASE_MS: '',
      POLL_MS: ' ',
      CONCURRENCY: '\t',
    }),
  ).toMatchObject({
    LEASE_MS: 30000,
    POLL_MS: 200,
    CONCURRENCY: 3,
  })
})

test('lease must exceed three polling intervals, including equality', () => {
  for (const LEASE_MS of ['599', '600']) {
    expect(
      errorMessage(() =>
        readWorkerEnv({ ...workerInput, LEASE_MS, POLL_MS: '200' }),
      ),
    ).toContain('LEASE_MS')
  }
  expect(
    readWorkerEnv({
      ...workerInput,
      LEASE_MS: '601',
      POLL_MS: '200',
      CONCURRENCY: '4',
    }),
  ).toMatchObject({
    LEASE_MS: 601,
    POLL_MS: 200,
    CONCURRENCY: 4,
  })
})

test('worker and egress enforce the signing secret length boundary', () => {
  for (const read of [readWorkerEnv, readEgressEnv]) {
    expect(
      errorMessage(() =>
        read({ ...workerInput, TURN_TOKEN_SECRET: 'x'.repeat(31) }),
      ),
    ).toContain('TURN_TOKEN_SECRET')
    expect(
      read({ ...workerInput, TURN_TOKEN_SECRET: 'x'.repeat(32) })
        .TURN_TOKEN_SECRET,
    ).toHaveLength(32)
  }
})
