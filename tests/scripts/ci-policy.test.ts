import { expect, test } from 'bun:test'
import { join, resolve } from 'node:path'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'

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
