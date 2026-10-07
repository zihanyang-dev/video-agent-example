import { expect, test } from 'bun:test'
import { readAdministrationEnv, readMigrationEnv, readServerEnv, readWorkerEnv } from './env'

const authenticationInput = {
  AUTH_BASE_URL: 'https://app.example',
  AUTH_SECRET: 'x'.repeat(32),
  GITHUB_CLIENT_ID: 'fixture',
  GITHUB_CLIENT_SECRET: 'fixture-secret',
}
const storageInput = {
  OBJECT_STORAGE_URL: 'http://objects:9000',
  OBJECT_STORAGE_REGION: 'us-east-1',
  OBJECT_STORAGE_BUCKET: 'files',
  OBJECT_STORAGE_ACCESS_KEY_ID: 'test',
  OBJECT_STORAGE_SECRET_ACCESS_KEY: 'test-secret',
}
const budgets = {
  ASSET_MAX_BYTES: 8388608,
  ASSET_MAX_FILES: 16,
  FILE_IO_TIMEOUT_MS: 30000,
}
const connections = {
  ...storageInput,
  DATABASE_URL: 'postgresql://app:secret@postgres/app',
  REDIS_URL: 'redis://redis:6379',
}
const workerInput = {
  ...connections,
  MODEL_BASE_URL: 'https://model.example/v1',
  MODEL_API_KEY: 'test-model-secret',
  MODEL_ID: 'test-model',
  MODEL_CONTEXT_WINDOW: '8192',
  MODEL_MAX_OUTPUT_TOKENS: '1024',
  E2B_API_URL: 'https://api.e2b.app',
  E2B_SANDBOX_URL: 'https://sandbox.e2b.app',
  E2B_API_KEY: 'test-sandbox-secret',
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
    readServerEnv({
      ...workerInput,
      ...authenticationInput,
      PORT: ' \t ',
      FAL_KEY: 'private',
    }),
  ).toEqual({
    ...connections,
    ...budgets,
    PORT: 8787,
    ...authenticationInput,
    IO_TIMEOUT_MS: 5000,
    POLL_MS: 200,
  })
})

test('worker has complete execution configuration and no provider secrets', () => {
  expect(readWorkerEnv({ ...workerInput, FAL_KEY: 'private' })).toEqual({
    ...workerInput,
    ...budgets,
    WEB_SEARCH_AUTH_MODE: 'keyless',
    MODEL_CONTEXT_WINDOW: 8192,
    MODEL_MAX_OUTPUT_TOKENS: 1024,
    MODEL_REASONING: false,
    MODEL_INPUT: 'text',
    MODEL_PROMPT_PATH: '/app/apps/agent/prompt.md',
    E2B_TEMPLATE: 'base',
    SANDBOX_TIMEOUT_MS: 300000,
    LEASE_MS: 30000,
    POLL_MS: 200,
    EVENT_OUTBOX_RETENTION_MS: 2592000000,
    CONCURRENCY: 3,
    IO_TIMEOUT_MS: 5000,
  })
})

test('worker admits the explicit 30-day SQL retention default and blank values', () => {
  for (const value of [undefined, '', '2592000000']) {
    expect(
      readWorkerEnv({ ...workerInput, EVENT_OUTBOX_RETENTION_MS: value }).EVENT_OUTBOX_RETENTION_MS,
    ).toBe(2592000000)
  }
})

test('worker starts without credentials for a gateway it does not use', () => {
  expect(() => readWorkerEnv(workerInput)).not.toThrow()
})

test('local E2B overrides do not preserve obsolete Docker configuration', () => {
  const env = readWorkerEnv({
    ...workerInput,
    E2B_API_URL: 'http://127.0.0.1:3000',
    E2B_SANDBOX_URL: 'http://127.0.0.1:3002',
    E2B_TEMPLATE: 'video-runtime',
    SANDBOX_TIMEOUT_MS: '600000',
    SANDBOX_IMAGE: 'obsolete',
    SANDBOX_NETWORK: 'obsolete',
  })
  expect(env).toMatchObject({
    E2B_API_URL: 'http://127.0.0.1:3000',
    E2B_SANDBOX_URL: 'http://127.0.0.1:3002',
    E2B_TEMPLATE: 'video-runtime',
    SANDBOX_TIMEOUT_MS: 600000,
  })
  expect(env).not.toHaveProperty('SANDBOX_IMAGE')
  expect(env).not.toHaveProperty('SANDBOX_NETWORK')
})

test('model output budget must fit within the configured endpoint context', () => {
  expect(
    errorMessage(() =>
      readWorkerEnv({
        ...workerInput,
        MODEL_MAX_OUTPUT_TOKENS: '8192',
      }),
    ),
  ).toContain('MODEL_MAX_OUTPUT_TOKENS')
  expect(
    errorMessage(() =>
      readWorkerEnv({
        ...workerInput,
        MODEL_CONTEXT_WINDOW: '',
      }),
    ),
  ).toContain('MODEL_CONTEXT_WINDOW')
})

test('model capabilities are explicit without treating false as a truthy string', () => {
  expect(readWorkerEnv({ ...workerInput, MODEL_REASONING: 'false' }).MODEL_REASONING).toBe(false)
  expect(
    readWorkerEnv({
      ...workerInput,
      MODEL_REASONING: 'true',
      MODEL_INPUT: 'text,image',
    }).MODEL_INPUT,
  ).toBe('text,image')
})

test('administration projects only SQL connection and its bounded deadline', () => {
  expect(
    readAdministrationEnv({
      ...workerInput,
      ...authenticationInput,
      IO_TIMEOUT_MS: '1000',
    }),
  ).toEqual({ DATABASE_URL: connections.DATABASE_URL, IO_TIMEOUT_MS: 1000 })
  expect(
    readAdministrationEnv({
      DATABASE_URL: connections.DATABASE_URL,
      IO_TIMEOUT_MS: ' ',
    }),
  ).toEqual({ DATABASE_URL: connections.DATABASE_URL, IO_TIMEOUT_MS: 5000 })
  const error = errorMessage(() =>
    readAdministrationEnv({
      DATABASE_URL: 'PRIVATE-INVALID-URL',
      IO_TIMEOUT_MS: '999',
    }),
  )
  expect(error).toContain('DATABASE_URL')
  expect(error).toContain('IO_TIMEOUT_MS')
  expect(error).not.toContain('PRIVATE-INVALID-URL')
})

test('sandbox lifetime is independent of SQL heartbeat timing', () => {
  expect(
    readWorkerEnv({
      ...workerInput,
      IO_TIMEOUT_MS: '60000',
      SANDBOX_TIMEOUT_MS: '66000',
    }).SANDBOX_TIMEOUT_MS,
  ).toBe(66000)
})

test('deployment uses the same configuration limits as library callers', () => {
  expect(
    readServerEnv({
      ...connections,
      ...authenticationInput,
      VID_DEPLOYMENT: 'compose',
      IO_TIMEOUT_MS: '6000',
      FILE_IO_TIMEOUT_MS: '30001',
    }),
  ).toMatchObject({ IO_TIMEOUT_MS: 6000, FILE_IO_TIMEOUT_MS: 30001 })
  expect(
    readWorkerEnv({
      ...workerInput,
      VID_DEPLOYMENT: 'compose',
      CONCURRENCY: '4',
      SANDBOX_TIMEOUT_MS: '300001',
    }),
  ).toMatchObject({ CONCURRENCY: 4, SANDBOX_TIMEOUT_MS: 300001 })
  expect(readWorkerEnv(workerInput)).not.toHaveProperty('VID_DEPLOYMENT')
})

test('migration requires only its database connection', () => {
  expect(readMigrationEnv(workerInput)).toEqual({
    DATABASE_URL: connections.DATABASE_URL,
  })
  expect(errorMessage(() => readMigrationEnv({ DATABASE_URL: '\n\t' }))).toContain('DATABASE_URL')
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
        'E2B_API_URL',
        'E2B_SANDBOX_URL',
        'E2B_API_KEY',
      ],
    ],
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
      OBJECT_STORAGE_SECRET_ACCESS_KEY: 'VALID-OBJECT-SECRET',
      CONCURRENCY: 'INVALID-NUMBER-SECRET',
    }),
  )
  for (const field of ['DATABASE_URL', 'REDIS_URL', 'MODEL_BASE_URL', 'CONCURRENCY']) {
    expect(message).toContain(field)
  }
  for (const secret of [
    'URL-SECRET',
    'VALID-KEY-SECRET',
    'VALID-OBJECT-SECRET',
    'INVALID-NUMBER-SECRET',
  ]) {
    expect(message).not.toContain(secret)
  }
})

test('whitespace-only required worker values are missing', () => {
  for (const field of Object.keys(workerInput)) {
    expect(errorMessage(() => readWorkerEnv({ ...workerInput, [field]: ' \n\t ' }))).toContain(
      field,
    )
  }
})

test('endpoint URLs accept HTTP(S) and reject other schemes or malformed URLs', () => {
  for (const field of ['MODEL_BASE_URL', 'E2B_API_URL', 'E2B_SANDBOX_URL'] as const) {
    for (const endpoint of ['ftp://host/path', 'file:///tmp/model', 'not-a-url']) {
      expect(errorMessage(() => readWorkerEnv({ ...workerInput, [field]: endpoint }))).toContain(
        field,
      )
    }
    for (const endpoint of ['http://localhost:8080', 'https://model.example/v1']) {
      expect(readWorkerEnv({ ...workerInput, [field]: endpoint })[field]).toBe(endpoint)
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
      readServerEnv({ ...connections, ...authenticationInput, REDIS_URL }),
    )
    expect(diagnostic).toContain('REDIS_URL')
    expect(diagnostic).not.toContain('private-password')
  }
  expect(readMigrationEnv({ DATABASE_URL: 'postgres://db/app' }).DATABASE_URL).toBe(
    'postgres://db/app',
  )
  expect(
    readServerEnv({
      ...connections,
      ...authenticationInput,
      REDIS_URL: 'rediss://redis:6379',
    }).REDIS_URL,
  ).toBe('rediss://redis:6379')
})

test('numeric settings reject zero, negatives, fractions and nonnumbers', () => {
  for (const field of ['LEASE_MS', 'POLL_MS', 'CONCURRENCY', 'SANDBOX_TIMEOUT_MS']) {
    for (const invalid of ['0', '-1', '1.5', 'NaN', 'Infinity', 'invalid']) {
      expect(errorMessage(() => readWorkerEnv({ ...workerInput, [field]: invalid }))).toContain(
        field,
      )
    }
  }
  for (const PORT of ['0', '-1', '65536', '1.5', 'invalid'])
    expect(
      errorMessage(() => readServerEnv({ ...workerInput, ...authenticationInput, PORT })),
    ).toContain('PORT')
  expect(readServerEnv({ ...workerInput, ...authenticationInput, PORT: '65535' }).PORT).toBe(65535)
})

test('sandbox lifetime is bounded independently of worker lease renewal', () => {
  expect(
    errorMessage(() => readWorkerEnv({ ...workerInput, SANDBOX_TIMEOUT_MS: '3600001' })),
  ).toContain('SANDBOX_TIMEOUT_MS')
  expect(readWorkerEnv({ ...workerInput, SANDBOX_TIMEOUT_MS: '3600000' }).SANDBOX_TIMEOUT_MS).toBe(
    3600000,
  )
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
    IO_TIMEOUT_MS: 5000,
  })
})

test('lease must exceed three polling intervals, including equality', () => {
  for (const LEASE_MS of ['599', '600']) {
    expect(
      errorMessage(() => readWorkerEnv({ ...workerInput, LEASE_MS, POLL_MS: '200' })),
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

test('Redis database path is validated before client construction without exposing secrets', () => {
  for (const path of ['not-a-db', '-1', '1.5', '1/2', '1secret']) {
    const REDIS_URL = `redis://user:PRIVATE-REDIS-PASSWORD@redis/${path}`
    for (const read of [readServerEnv, readWorkerEnv]) {
      const diagnostic = errorMessage(() =>
        read({ ...workerInput, ...authenticationInput, REDIS_URL }),
      )
      expect(diagnostic).toContain('REDIS_URL')
      expect(diagnostic).not.toContain('PRIVATE-REDIS-PASSWORD')
      expect(diagnostic).not.toContain(REDIS_URL)
    }
  }
  for (const REDIS_URL of [
    'redis://redis',
    'redis://redis/',
    'redis://redis/0',
    'rediss://redis/12',
  ]) {
    expect(readServerEnv({ ...connections, ...authenticationInput, REDIS_URL }).REDIS_URL).toBe(
      REDIS_URL,
    )
  }
})

test('runtime has bounded IO and a authentication configured only on the server', () => {
  expect(readServerEnv({ ...connections, ...authenticationInput })).toMatchObject({
    ...authenticationInput,
    IO_TIMEOUT_MS: 5000,
    POLL_MS: 200,
  })
  expect(readWorkerEnv(workerInput)).toMatchObject({ IO_TIMEOUT_MS: 5000 })
  for (const IO_TIMEOUT_MS of ['0', '999', '60001']) {
    const diagnostic = errorMessage(() =>
      readServerEnv({ ...connections, ...authenticationInput, IO_TIMEOUT_MS }),
    )
    expect(diagnostic).toContain('IO_TIMEOUT_MS')
    expect(diagnostic).not.toContain('AUTH')
  }
  for (const IO_TIMEOUT_MS of ['1000', '60000'])
    expect(
      readServerEnv({ ...connections, ...authenticationInput, IO_TIMEOUT_MS }).IO_TIMEOUT_MS,
    ).toBe(Number(IO_TIMEOUT_MS))
})

test('trusted model prompt path defaults for blanks and accepts explicit assignment', () => {
  expect(readWorkerEnv({ ...workerInput, MODEL_PROMPT_PATH: ' ' }).MODEL_PROMPT_PATH).toBe(
    '/app/apps/agent/prompt.md',
  )
  expect(
    readWorkerEnv({ ...workerInput, MODEL_PROMPT_PATH: '/trusted/custom.md' }).MODEL_PROMPT_PATH,
  ).toBe('/trusted/custom.md')
})

test('server requires canonical authentication origin and private provider credentials', () => {
  const diagnostic = errorMessage(() => readServerEnv(connections))
  for (const field of ['AUTH_BASE_URL', 'AUTH_SECRET', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'])
    expect(diagnostic).toContain(field)
  expect(() =>
    readServerEnv({
      ...connections,
      ...authenticationInput,
      AUTH_BASE_URL: 'https://app.example/path',
    }),
  ).toThrow()
  expect(() =>
    readServerEnv({
      ...connections,
      ...authenticationInput,
      AUTH_SECRET: 'short',
    }),
  ).toThrow()
  expect(
    readServerEnv({
      ...connections,
      ...authenticationInput,
      OPERATOR_ID: 'ignored',
    }),
  ).not.toHaveProperty('OPERATOR_ID')
})

test('malformed authentication origins join safe configuration diagnostics', () => {
  const message = errorMessage(() =>
    readServerEnv({
      ...connections,
      ...authenticationInput,
      AUTH_BASE_URL: 'MALFORMED-PRIVATE-ORIGIN',
      AUTH_SECRET: 'SHORT-PRIVATE-SECRET',
    }),
  )
  expect(message).toContain('AUTH_BASE_URL')
  expect(message).toContain('AUTH_SECRET')
  expect(message).not.toContain('MALFORMED-PRIVATE-ORIGIN')
  expect(message).not.toContain('SHORT-PRIVATE-SECRET')
})

test('authentication origins require HTTPS except explicit HTTP loopback development', () => {
  for (const AUTH_BASE_URL of [
    'http://app.example',
    'https://app.example/',
    'https://user:password@app.example',
    'https://app.example?query',
    'https://app.example#fragment',
  ]) {
    expect(() => readServerEnv({ ...connections, ...authenticationInput, AUTH_BASE_URL })).toThrow()
  }
  for (const AUTH_BASE_URL of [
    'https://app.example',
    'http://127.0.0.1:8787',
    'http://localhost:8787',
    'http://[::1]:8787',
  ]) {
    expect(
      readServerEnv({ ...connections, ...authenticationInput, AUTH_BASE_URL }).AUTH_BASE_URL,
    ).toBe(AUTH_BASE_URL)
  }
})

test('asset budgets reject invalid bounds before either process opens storage', () => {
  for (const read of [readServerEnv, readWorkerEnv]) {
    for (const [field, setting] of [
      ['ASSET_MAX_BYTES', '0'],
      ['ASSET_MAX_BYTES', '-1'],
      ['ASSET_MAX_BYTES', '1.5'],
      ['ASSET_MAX_BYTES', 'Infinity'],
      ['ASSET_MAX_FILES', '0'],
      ['ASSET_MAX_FILES', '-1'],
      ['ASSET_MAX_FILES', '1.5'],
      ['ASSET_MAX_FILES', 'Infinity'],
    ] as const)
      expect(
        errorMessage(() => read({ ...workerInput, ...authenticationInput, [field]: setting })),
      ).toContain(field)
  }
})

test('server and worker require explicit object credentials and bounded file budgets', () => {
  for (const read of [readServerEnv, readWorkerEnv]) {
    const message = errorMessage(() =>
      read({
        ...workerInput,
        ...authenticationInput,
        OBJECT_STORAGE_ACCESS_KEY_ID: undefined,
        OBJECT_STORAGE_SECRET_ACCESS_KEY: undefined,
      }),
    )
    expect(message).toContain('OBJECT_STORAGE_ACCESS_KEY_ID')
    expect(message).toContain('OBJECT_STORAGE_SECRET_ACCESS_KEY')
  }
})

test('both process polling policies preserve defaults and reject unsupported intervals', () => {
  const input = { ...workerInput, ...authenticationInput, LEASE_MS: '60000' }
  for (const read of [readServerEnv, readWorkerEnv]) {
    expect(read({ ...input, POLL_MS: undefined }).POLL_MS).toBe(200)
    expect(read({ ...input, POLL_MS: ' ' }).POLL_MS).toBe(200)
    expect(read({ ...input, POLL_MS: '1' }).POLL_MS).toBe(1)
    expect(read({ ...input, POLL_MS: '10000' }).POLL_MS).toBe(10000)
    for (const setting of ['0', '-1', '1.5', 'Infinity', '10001'])
      expect(errorMessage(() => read({ ...input, POLL_MS: setting }))).toContain('POLL_MS')
  }
})

test('worker timer and concurrency bounds reject overflow but retain supported endpoints', () => {
  for (const [field, setting] of [
    ['LEASE_MS', '2147483648'],
    ['POLL_MS', '10001'],
    ['CONCURRENCY', '33'],
  ] as const)
    expect(errorMessage(() => readWorkerEnv({ ...workerInput, [field]: setting }))).toContain(field)
  expect(
    readWorkerEnv({
      ...workerInput,
      LEASE_MS: '2147483647',
      POLL_MS: '10000',
      CONCURRENCY: '32',
    }),
  ).toMatchObject({ LEASE_MS: 2147483647, POLL_MS: 10000, CONCURRENCY: 32 })
  expect(readWorkerEnv({ ...workerInput, SANDBOX_PROVIDER: 'unused' })).not.toHaveProperty(
    'SANDBOX_PROVIDER',
  )
})

test('worker selects keyless demo auth explicitly and keyed auth requires a worker-only key', () => {
  expect(readWorkerEnv(workerInput)).toMatchObject({
    WEB_SEARCH_AUTH_MODE: 'keyless',
  })
  expect(
    readWorkerEnv({
      ...workerInput,
      WEB_SEARCH_AUTH_MODE: 'key',
      TAVILY_API_KEY: 'fixture-search-key',
    }),
  ).toMatchObject({
    WEB_SEARCH_AUTH_MODE: 'key',
    TAVILY_API_KEY: 'fixture-search-key',
  })
  for (const fields of [
    { WEB_SEARCH_AUTH_MODE: 'key' },
    { WEB_SEARCH_AUTH_MODE: 'fallback' },
    { WEB_SEARCH_AUTH_MODE: 'keyless', TAVILY_API_KEY: 'PRIVATE' },
  ]) {
    expect(errorMessage(() => readWorkerEnv({ ...workerInput, ...fields }))).not.toContain(
      'PRIVATE',
    )
  }
  expect(
    readServerEnv({
      ...connections,
      ...authenticationInput,
      WEB_SEARCH_AUTH_MODE: 'key',
      TAVILY_API_KEY: 'PRIVATE',
    }),
  ).not.toHaveProperty('TAVILY_API_KEY')
})
