import { expect, test } from 'bun:test'
import { join, resolve } from 'node:path'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'

const root = resolve(import.meta.dir, '../..')
type Step = {
  uses?: string
  run?: string
  if?: string
  with?: Record<string, unknown>
}
type Workflow = {
  on: Record<string, unknown>
  permissions: Record<string, string>
  concurrency: { 'cancel-in-progress': boolean }
  jobs: Record<string, { 'runs-on': string; 'timeout-minutes': number; steps: Step[] }>
}
async function workflow() {
  return Bun.YAML.parse(await Bun.file(join(root, '.github/workflows/ci.yaml')).text()) as Workflow
}

test('PR checks never receive write permissions or persistent checkout credentials', async () => {
  const config = await workflow()
  expect(Object.keys(config.on).sort()).toEqual(['pull_request', 'push'])
  expect(config.permissions).toEqual({ contents: 'read' })
  expect(config.concurrency['cancel-in-progress']).toBe(true)
  for (const job of Object.values(config.jobs)) {
    expect(job['runs-on']).toBe('ubuntu-24.04')
    expect(job['timeout-minutes']).toBeGreaterThan(0)
    expect(job['timeout-minutes']).toBeLessThanOrEqual(45)
    const checkout = job.steps.find((step) => step.uses?.startsWith('actions/checkout@'))
    expect(checkout?.with?.['persist-credentials']).toBe(false)
  }
  for (const step of Object.values(config.jobs).flatMap((job) => job.steps)) {
    if (step.uses) expect(step.uses).toMatch(/^[\w/-]+@[a-f0-9]{40}$/)
    expect(step.run ?? '').not.toMatch(/secrets\.|id-token|ssh |retry/)
  }
})

test('storage initialization ships policy sources without daemon host binds', async () => {
  const config = Bun.YAML.parse(await Bun.file(join(root, 'compose.yaml')).text()) as {
    services: Record<string, { build?: { target?: string }; volumes?: unknown[] }>
  }
  const initialization = config.services['storage-init']
  expect(initialization?.build?.target).toBe('storage-init')
  expect(initialization?.volumes ?? []).toEqual([])
})

test('deployment Compose does not inherit operator service credentials', async () => {
  const directory = await mkdtemp(join(root, 'vid-compose-environment-'))
  try {
    const source = await readFile(join(root, 'tests/scripts/deployment-check.sh'), 'utf8')
    const start = source.indexOf('compose() {')
    const end = source.indexOf('\ncleanup() {', start)
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    const docker = join(directory, 'docker')
    await writeFile(docker, '#!/bin/sh\n[ -z "${OBJECT_STORAGE_URL:-}" ] || exit 71\n', {
      mode: 0o700,
    })
    const child = Bun.spawn(
      [
        '/bin/sh',
        '-ec',
        `run_stage() { shift; "$@"; }\n${source.slice(start, end)}\ncompose config`,
      ],
      {
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          OBJECT_STORAGE_URL: 'https://operator-storage.invalid',
          root,
          staging: directory,
          project: 'owned-environment-probe',
          run_timeout: '5',
        },
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 5000,
        killSignal: 'SIGKILL',
      },
    )
    const [status, , errors] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(status, errors).toBe(0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('host Node is installed only for the integration Docker controller', async () => {
  const config = await workflow()
  const basic = config.jobs.basic
  const integration = config.jobs.integration
  if (!basic || !integration) throw new Error('Missing native CI jobs')
  expect(basic.steps.filter((step) => step.uses?.startsWith('actions/setup-node@'))).toEqual([])
  const nodeSteps = integration.steps.filter((step) => step.uses?.startsWith('actions/setup-node@'))
  expect(nodeSteps).toHaveLength(1)
  expect(nodeSteps[0]?.with?.['node-version']).toBe('24.21.0')
})

test('CI delegates the same complete deployment chain documented for local control', async () => {
  const config = await workflow()
  const commands = config.jobs.integration?.steps.map((step) => step.run ?? '').join('\n')
  expect(commands).toContain('sh scripts/deployment-check.sh')
  expect(commands).not.toContain('node --test tests/scripts/production-runtime.test.ts')
  expect(commands).not.toContain('sh tests/scripts/deployment-check.sh')
})

for (const failure of ['', 'production', 'storage']) {
  test(`the deployment entrypoint preserves prerequisite order and ${failure || 'successful'} exit`, async () => {
    const directory = await mkdtemp(join(root, 'vid-deployment-entrypoint-'))
    let child: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined
    try {
      await mkdir(join(directory, 'scripts'))
      await mkdir(join(directory, 'bin'))
      await mkdir(join(directory, 'tests/scripts'), { recursive: true })
      await writeFile(
        join(directory, 'scripts/deployment-check.sh'),
        await readFile(join(root, 'scripts/deployment-check.sh')),
      )
      const log = join(directory, 'order')
      const node = join(directory, 'bin/node')
      await writeFile(
        node,
        `#!/bin/sh\ncase "$*" in\n  *production-runtime*) stage=production ;;\n  *storage-initialization*) stage=storage ;;\n  *) exit 9 ;;\nesac\nprintf '%s\\n' "$stage" >> "$OWNED_ORDER"\n[ "$stage" != "$OWNED_FAILURE" ] || exit 7\n`,
      )
      await chmod(node, 0o700)
      await writeFile(
        join(directory, 'tests/scripts/deployment-check.sh'),
        '#!/bin/sh\nprintf "compose\\n" >> "$OWNED_ORDER"\n',
      )
      child = Bun.spawn(['/bin/sh', join(directory, 'scripts/deployment-check.sh')], {
        cwd: root,
        env: {
          ...process.env,
          PATH: `${join(directory, 'bin')}:${process.env.PATH}`,
          OWNED_ORDER: log,
          OWNED_FAILURE: failure,
        },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 5000,
        killSignal: 'SIGKILL',
      })
      const [exit] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(exit).toBe(failure ? 7 : 0)
      expect((await readFile(log, 'utf8')).trim().split('\n')).toEqual(
        failure === 'production'
          ? ['production']
          : failure === 'storage'
            ? ['production', 'storage']
            : ['production', 'storage', 'compose'],
      )
    } finally {
      if (child?.exitCode === null) child.kill('SIGKILL')
      await child?.exited
      await rm(directory, { recursive: true, force: true })
    }
  })
}

for (const { gate, source } of [
  { gate: 'typecheck', source: 'export const invalid: string = 1\n' },
  { gate: 'lint', source: "Promise.resolve('unobserved CI work')\n" },
]) {
  test(`the ${gate} gate rejects invalid executable CI TypeScript`, async () => {
    const directory = await mkdtemp(join(root, '.github', `vid-${gate}-`))
    const name = `scope-${gate}.ts`
    const path = join(directory, name)
    let child: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined
    let drains: Promise<string>[] = []
    try {
      await writeFile(path, source, { flag: 'wx' })
      child = Bun.spawn([process.execPath, 'run', gate], {
        cwd: root,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 30000,
        killSignal: 'SIGKILL',
      })
      const stdout = new Response(child.stdout).text()
      const stderr = new Response(child.stderr).text()
      drains = [stdout, stderr]
      const [output, errors, exitCode] = await Promise.all([stdout, stderr, child.exited])
      expect(exitCode).not.toBe(0)
      expect(`${output}\n${errors}`).toContain(name)
    } finally {
      if (child?.exitCode === null) child.kill('SIGKILL')
      await child?.exited
      await Promise.allSettled(drains)
      await rm(directory, { recursive: true, force: true })
    }
  }, 40000)
}

test('route schema references reject names absent from the actual contract owner', async () => {
  const directory = await mkdtemp(join(root, 'apps/server', 'vid-schema-reference-'))
  const name = 'route-schema-reference.ts'
  let child: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined
  let drains: Promise<string>[] = []
  try {
    // Compile the real route module with one invalid reference; do not mirror
    // the production name union in this fixture. Preserve relative resolution.
    const source = await readFile(join(root, 'apps/server/src/http.ts'), 'utf8')
    const route = source.replace(
      /from '(\.[^']+)'/g,
      (_match, path: string) => `from ${JSON.stringify(resolve(root, 'apps/server/src', path))}`,
    )
    await writeFile(join(directory, name), `${route}\njson('MessageSubmisionInput')\n`, {
      flag: 'wx',
    })
    child = Bun.spawn([process.execPath, 'run', 'typecheck'], {
      cwd: root,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 30000,
      killSignal: 'SIGKILL',
    })
    const stdout = new Response(child.stdout).text()
    const stderr = new Response(child.stderr).text()
    drains = [stdout, stderr]
    const [output, errors, exitCode] = await Promise.all([stdout, stderr, child.exited])
    expect(exitCode).not.toBe(0)
    const diagnostic = `${output}\n${errors}`
    expect(diagnostic).toContain(name)
    expect(diagnostic).toContain('MessageSubmisionInput')
    expect(diagnostic.match(/error TS\d+/g)).toEqual(['error TS2345'])
  } finally {
    if (child?.exitCode === null) child.kill('SIGKILL')
    await child?.exited
    await Promise.allSettled(drains)
    await rm(directory, { recursive: true, force: true })
  }
}, 40000)

test('failure artifacts contain explicit logs, not operator configuration', async () => {
  const config = await workflow()
  for (const job of Object.values(config.jobs)) {
    const upload = job.steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'))!
    expect(upload.if).toBe('failure()')
    expect(upload.with?.['include-hidden-files']).not.toBe(true)
    for (const path of String(upload.with?.path).trim().split('\n')) {
      expect(path).toMatch(/^ci-logs\/[a-z-]+\.log$/)
    }
  }
})
