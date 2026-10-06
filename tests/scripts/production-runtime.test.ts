import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const docker = (...args: string[]) =>
  execFileSync('docker', args, { encoding: 'utf8', timeout: 600000 })
function logs(id: string) {
  const result = spawnSync('docker', ['logs', id], {
    encoding: 'utf8',
    timeout: 10000,
  })
  assert.equal(result.status, 0)
  return result.stdout + result.stderr
}
function removeOwned(id: string | undefined, owner: string) {
  if (id === undefined) return
  assert.equal(
    docker(
      'inspect',
      '--format',
      '{{index .Config.Labels "vid.check.owner"}}',
      id,
    ).trim(),
    owner,
  )
  docker('rm', '-f', id)
}

function cleanup(id: string | undefined, owner: string, context: string) {
  try {
    removeOwned(id, owner)
  } finally {
    rmSync(context, { recursive: true, force: true })
  }
}

// Build a source-only context: never send config/.env or operator material to Docker.
const contextPaths = [
  'package.json',
  'bun.lock',
  'deploy/docker/application.Dockerfile',
  'apps/server',
  'apps/agent',
  'packages/config',
  'packages/contract',
  'packages/database',
  'packages/object-storage',
]
const inventory = `
import { readdirSync, readFileSync, realpathSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
const agentRequire = createRequire('/app/apps/agent/package.json');
let sdkRoot = dirname(agentRequire.resolve('e2b'));
while (!existsSync(join(sdkRoot, 'package.json')) || JSON.parse(readFileSync(join(sdkRoot, 'package.json'), 'utf8')).name !== 'e2b') sdkRoot = dirname(sdkRoot);
const pkg = JSON.parse(readFileSync(join(sdkRoot, 'package.json'), 'utf8'));
if (pkg.version !== '2.52.0') throw new Error('Unexpected official e2b version');
console.log('official-e2b-ok', pkg.version);
const forbidden = new Set(['typescript', 'oxlint', 'oxlint-tsgolint', 'prettier',
  'dependency-cruiser', '@swc/core', '@hey-api/openapi-ts', 'kysely-codegen',
  'dbmate', 'react', 'react-dom', '@ag-ui/client', 'tailwindcss', '@tailwindcss/cli',
  '@tanstack/react-query', '@fontsource-variable/geist', '@fontsource-variable/geist-mono',
  'reicon-react', '@types/react', '@types/react-dom']);
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.isFile() && entry.name === 'package.json') {
      const pkg = JSON.parse(readFileSync(path, 'utf8'));
      if (forbidden.has(pkg.name)) throw new Error('Forbidden runtime dependency: ' + pkg.name);
    }
  }
}
walk('/app/node_modules');
if (existsSync('/root/.bun/install/cache')) walk('/root/.bun/install/cache');
if (existsSync('/home/bun/.bun/install/cache')) walk('/home/bun/.bun/install/cache');
for (const name of ['config', 'contract', 'database', 'object-storage']) {
  const path = '/app/packages/' + name;
  if (existsSync(path + '/generated') || existsSync(path + '/migrations'))
    throw new Error('Nonruntime artifact: ' + path);
  for (const app of ['server', 'agent']) {
    if (realpathSync('/app/apps/' + app + '/node_modules/@vid/' + name) !== path)
      throw new Error('Broken workspace target: ' + path);
  }
}
function sourceOnly(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sourceOnly(path);
    else if (entry.name.endsWith('.test.ts')) throw new Error('Shipped application test: ' + path);
  }
}
for (const dir of ['/app/apps', '/app/packages']) {
  for (const entry of readdirSync(dir)) {
    const src = join(dir, entry, 'src');
    if (existsSync(src)) sourceOnly(src);
  }
}
console.log('production-inventory-ok');
`
const environment = {
  DATABASE_URL: 'postgres://fixture:fixture@127.0.0.1:1/fixture',
  REDIS_URL: 'redis://127.0.0.1:1',
  OBJECT_STORAGE_URL: 'http://127.0.0.1:1',
  OBJECT_STORAGE_REGION: 'fixture',
  OBJECT_STORAGE_BUCKET: 'fixture',
  OBJECT_STORAGE_ACCESS_KEY_ID: 'fixture',
  OBJECT_STORAGE_SECRET_ACCESS_KEY: 'fixture',
  AUTH_BASE_URL: 'http://localhost:8787',
  AUTH_SECRET: 'synthetic-fixture-secret-at-least-32-characters',
  GITHUB_CLIENT_ID: 'fixture',
  GITHUB_CLIENT_SECRET: 'fixture',
  MODEL_BASE_URL: 'http://127.0.0.1:1',
  MODEL_API_KEY: 'fixture',
  MODEL_ID: 'fixture',
  MODEL_CONTEXT_WINDOW: '4096',
  MODEL_MAX_OUTPUT_TOKENS: '1024',
  E2B_API_URL: 'http://127.0.0.1:1',
  E2B_SANDBOX_URL: 'http://127.0.0.1:1',
  E2B_API_KEY: 'fixture',
}

for (const service of ['server', 'worker']) {
  void test(
    `${service} frozen production image excludes build deps and loads native CMD`,
    { timeout: 720000 },
    () => {
      const context = mkdtempSync(join(tmpdir(), 'vid-production-'))
      const owner = `vid-production-${crypto.randomUUID()}`
      let id: string | undefined
      try {
        for (const path of contextPaths) {
          cpSync(path, join(context, path), {
            recursive: true,
            filter: (source) =>
              !/(?:^|\/)(?:node_modules|\.cache|dist|coverage|\.env[^/]*)(?:\/|$)/.test(
                source,
              ),
          })
        }
        const image = docker(
          'build',
          '--quiet',
          '--label',
          `vid.check.owner=${owner}`,
          '--target',
          service,
          '-f',
          join(context, 'deploy/docker/application.Dockerfile'),
          context,
        ).trim()
        assert.match(image, /^sha256:[a-f0-9]{64}$/)
        console.info(`${service} production image: ${image}`)
        const installed = execFileSync(
          'docker',
          [
            'run',
            '--rm',
            '-i',
            '--network',
            'none',
            '--label',
            `vid.check.owner=${owner}`,
            '--user',
            'root',
            '--entrypoint',
            'bun',
            image,
            '--eval',
            inventory,
          ],
          {
            encoding: 'utf8',
            timeout: 600000,
          },
        )
        assert.match(installed, /production-inventory-ok/)
        assert.match(installed, /official-e2b-ok 2\.52\.0/)
        // Node remains a real executable, not a Bun symlink; exercise native Pi/E2B ESM exports.
        if (service === 'worker') {
          assert.match(
            docker(
              'run',
              '--rm',
              '--network',
              'none',
              '--label',
              `vid.check.owner=${owner}`,
              '--workdir',
              '/app/apps/agent',
              '--entrypoint',
              'bun',
              image,
              '--eval',
              `const { spawnSync } = await import('node:child_process');
const child = spawnSync('node', ['--input-type=module', '--eval', "await import('@earendil-works/pi-coding-agent'); await import('e2b'); console.log('node-native-ok', process.release.name)"], { encoding: 'utf8' });
if (child.status !== 0) throw new Error(child.stderr || String(child.error));
console.log(child.stdout);`,
            ),
            /node-native-ok node/,
          )
        }
        const entry = service === 'worker' ? 'agent' : 'server'
        const cmd = JSON.parse(
          docker('image', 'inspect', '--format', '{{json .Config.Cmd}}', image),
        ) as string[]
        assert.deepEqual(cmd, ['bun', `apps/${entry}/src/main.ts`])
        const env = Object.entries(environment)
          .filter(([key]) =>
            service === 'worker'
              ? !/^(AUTH_|GITHUB_)/.test(key)
              : !/^(MODEL_|E2B_)/.test(key),
          )
          .flatMap(([key, value]) => ['--env', `${key}=${value}`])
        id = docker(
          'create',
          '--network',
          'none',
          '--label',
          `vid.check.owner=${owner}`,
          ...env,
          image,
        ).trim()
        docker('start', id)
        // The unchanged CMD must fail privately when native services are absent.
        assert.equal(docker('wait', id).trim(), '1')
        assert.match(logs(id), /Process stopped after failure/)
        assert.match(logs(id), new RegExp(`${service}-entrypoint`))
        assert.doesNotMatch(logs(id), /ECONNREFUSED|postgres:\/\/|redis:\/\//)
        assert.doesNotMatch(
          logs(id),
          /Cannot find|ModuleNotFound|ENOENT|Invalid environment/,
        )
        removeOwned(id, owner)
        id = undefined
      } finally {
        cleanup(id, owner, context)
      }
    },
  )
}
