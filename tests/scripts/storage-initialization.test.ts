import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const slot = 'arn:aws:s3:::vid-assets/'
const roles = ['server', 'worker'] as const
type NativePolicyRole = (typeof roles)[number]
interface Policy {
  Version: string
  Id?: string
  Statement: {
    Effect: string
    Action: string[]
    Resource: string[]
    Sid?: string
  }[]
}
const policies = Object.fromEntries(
  roles.map((role) => [role, readFileSync(`deploy/storage/${role}-policy.json`, 'utf8')]),
) as Record<NativePolicyRole, string>

// Contract for this literal template, NOT an arbitrary JSON renderer. Real JSON
// parsing proves every reserved slot is an unescaped Resource bucket prefix.
function conform(text: string): Policy {
  const policy = JSON.parse(text) as Policy
  const resources = policy.Statement.flatMap((statement) => statement.Resource)
  for (const resource of resources) assert.ok(resource.startsWith(slot))
  const withoutResources = {
    ...policy,
    Statement: policy.Statement.map(({ Resource: _resource, ...rest }) => rest),
  }
  assert.ok(!JSON.stringify(withoutResources).includes(slot))
  assert.equal(text.split(slot).length - 1, resources.length)
  return policy
}

void test('NativePolicyRole canonical JSON conformance and permissions', () => {
  for (const role of roles) {
    const policy = conform(policies[role])
    assert.equal(policy.Version, '2012-10-17')
    assert.deepEqual(
      policy.Statement.map((statement) => statement.Effect),
      ['Allow', 'Allow'],
    )
    assert.deepEqual(
      policy.Statement.map((statement) => statement.Action),
      [['s3:GetObject'], ['s3:PutObject']],
    )
    assert.deepEqual(policy.Statement[0]?.Resource, [
      `${slot}assets/uploads/*`,
      `${slot}assets/generated/*`,
      `${slot}materials/*`,
      `${slot}artifacts/*`,
    ])
    assert.deepEqual(policy.Statement[1]?.Resource, [
      `${slot}assets/${role === 'server' ? 'uploads' : 'generated'}/*`,
    ])
  }
  const misplaced = JSON.parse(policies.server) as Policy
  misplaced.Id = slot
  assert.throws(() => conform(JSON.stringify(misplaced)))
  assert.throws(() => conform(policies.server.replace('arn:aws:', 'arn:aws:\\u0073')))
})

// No inherited operator configuration. Compose reads /dev/null, not .env.
const synthetic = Object.fromEntries(
  [
    'POSTGRES_PASSWORD',
    'SERVER_DB_PASSWORD',
    'WORKER_DB_PASSWORD',
    'SERVER_REDIS_PASSWORD',
    'WORKER_REDIS_PASSWORD',
    'MODEL_API_KEY',
    'MODEL_ID',
    'E2B_API_KEY',
  ].map((key) => [key, 'ExplicitSyntheticfixture']),
)
Object.assign(synthetic, {
  OBJECT_STORAGE_ROOT_USER: 'SyntheticRoot',
  OBJECT_STORAGE_ROOT_PASSWORD: 'PrivateFakeCredentialRoot',
  SERVER_OBJECT_STORAGE_ACCESS_KEY_ID: 'SyntheticServer',
  SERVER_OBJECT_STORAGE_SECRET_ACCESS_KEY: 'PrivateFakeCredentialServer',
  WORKER_OBJECT_STORAGE_ACCESS_KEY_ID: 'SyntheticWorker',
  WORKER_OBJECT_STORAGE_SECRET_ACCESS_KEY: 'PrivateFakeCredentialWorker',
  OBJECT_STORAGE_URL: 'http://objects:9000',
  OBJECT_STORAGE_BUCKET: 'alternate-assets',
  MODEL_BASE_URL: 'http://unused.invalid',
  MODEL_CONTEXT_WINDOW: '4096',
  MODEL_MAX_OUTPUT_TOKENS: '1024',
  E2B_API_URL: 'http://unused.invalid',
  E2B_SANDBOX_URL: 'http://unused.invalid',
})
const docker = (...args: string[]) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    timeout: 120000,
  })
interface NativeService {
  build: { target: string }
  volumes?: unknown[]
  entrypoint: string[]
  command: string[]
  environment: Record<string, string>
}
function nativeCompose(): NativeService {
  const config = JSON.parse(
    execFileSync(
      'docker',
      ['compose', '--env-file', '/dev/null', '-f', 'compose.yaml', 'config', '--format', 'json'],
      {
        encoding: 'utf8',
        timeout: 30000,
        env: { PATH: process.env.PATH, DOCKER_HOST: process.env.DOCKER_HOST, ...synthetic },
      },
    ),
  ) as {
    services: Record<string, NativeService>
  }
  const service = config.services['storage-init']
  assert.ok(service)
  assert.deepEqual(service.entrypoint, ['bash'])
  assert.deepEqual(service.command, ['/policies/initialize.sh'])
  assert.equal(service.build.target, 'storage-init')
  assert.deepEqual(service.volumes ?? [], [])
  return service
}

let image: string | undefined
function initializationImage() {
  if (image !== undefined) return image
  const context = mkdtempSync(join(tmpdir(), 'vid-storage-source-'))
  try {
    for (const path of ['deploy/docker/application.Dockerfile', 'deploy/storage'])
      cpSync(path, join(context, path), { recursive: true })
    image = docker(
      'build',
      '--quiet',
      '--label',
      `vid.check.owner=vid-storage-source-${crypto.randomUUID()}`,
      '--target',
      'storage-init',
      '-f',
      join(context, 'deploy/docker/application.Dockerfile'),
      context,
    ).trim()
    assert.match(image, /^sha256:[a-f0-9]{64}$/)
    return image
  } finally {
    rmSync(context, { recursive: true, force: true })
  }
}

// Exercise real input validation and real offline connection failure. No fake mcli.
function runInitialization(overrides: Record<string, string> = {}) {
  const service = nativeCompose()
  const owner = `vid-storage-initialization-${crypto.randomUUID()}`
  let id: string | undefined
  try {
    id = docker(
      'create',
      '--network',
      'none',
      '--label',
      `vid.check.owner=${owner}`,
      '--tmpfs',
      '/run/storage:mode=0700',
      ...Object.entries({ ...service.environment, ...overrides }).flatMap(([key, value]) => [
        '--env',
        `${key}=${value}`,
      ]),
      '--entrypoint',
      'bash',
      initializationImage(),
      ...service.command,
    ).trim()
    docker('start', id)
    const status = Number(docker('wait', id).trim())
    const logs = spawnSync('docker', ['logs', id], {
      encoding: 'utf8',
      timeout: 10000,
    })
    assert.equal(logs.status, 0)
    return { status, output: logs.stdout + logs.stderr }
  } finally {
    if (id !== undefined) {
      assert.equal(
        docker('inspect', '--format', '{{index .Config.Labels "vid.check.owner"}}', id).trim(),
        owner,
      )
      docker('rm', '-f', '-v', id)
    }
  }
}

void test('invalid bucket and principal inputs fail privately before contacting storage', () => {
  for (const overrides of [
    { OBJECT_STORAGE_BUCKET: 'bad"bucket' },
    { OBJECT_STORAGE_BUCKET: '127.0.0.1' },
    { SERVER_ACCESS_KEY: 'SyntheticWorker' },
    { SERVER_ACCESS_KEY: 'SyntheticRoot' },
    { WORKER_ACCESS_KEY: 'SyntheticRoot' },
  ]) {
    const result = runInitialization(overrides)
    assert.notEqual(result.status, 0)
    assert.match(result.output, /initialization failed: input/)
    assert.doesNotMatch(result.output, /PrivateFakeCredential/)
  }
})

void test('external storage is not administered with local root credentials', () => {
  const result = runInitialization({
    OBJECT_STORAGE_URL: 'https://operator.invalid',
  })
  assert.equal(result.status, 0)
  assert.equal(result.output, '')
})

void test('real storage connection failure reports only the stage, not credentials', () => {
  const result = runInitialization()
  assert.notEqual(result.status, 0)
  assert.match(result.output, /Local object storage initialization failed: bucket/)
  assert.doesNotMatch(result.output, /PrivateFakeCredential/)
})
