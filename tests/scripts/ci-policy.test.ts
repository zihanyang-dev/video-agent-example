import { expect, test } from 'bun:test'
import { join, resolve } from 'node:path'

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
  jobs: Record<
    string,
    { 'runs-on': string; 'timeout-minutes': number; steps: Step[] }
  >
}
async function workflow() {
  return Bun.YAML.parse(
    await Bun.file(join(root, '.github/workflows/ci.yaml')).text(),
  ) as Workflow
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
    const checkout = job.steps.find((step) =>
      step.uses?.startsWith('actions/checkout@'),
    )
    expect(checkout?.with?.['persist-credentials']).toBe(false)
  }
  for (const step of Object.values(config.jobs).flatMap((job) => job.steps)) {
    if (step.uses) expect(step.uses).toMatch(/^[\w/-]+@[a-f0-9]{40}$/)
    expect(step.run ?? '').not.toMatch(/secrets\.|id-token|ssh |retry/)
  }
})

test('failure artifacts contain explicit logs, not operator configuration', async () => {
  const config = await workflow()
  for (const job of Object.values(config.jobs)) {
    const upload = job.steps.find((step) =>
      step.uses?.startsWith('actions/upload-artifact@'),
    )!
    expect(upload.if).toBe('failure()')
    expect(upload.with?.['include-hidden-files']).not.toBe(true)
    for (const path of String(upload.with?.path).trim().split('\n')) {
      expect(path).toMatch(/^ci-logs\/[a-z-]+\.log$/)
    }
  }
})
