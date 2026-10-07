import { expect, test } from 'bun:test'

for (const args of [
  ['review.json', '--apply'],
  ['command', crypto.randomUUID(), '--apply'],
  ['command', 'PRIVATE_INVALID_ID'],
  ['unknown', crypto.randomUUID()],
]) {
  test(`inspection CLI rejects unsupported arguments (${args.length}) before connecting`, async () => {
    const child = Bun.spawn([process.execPath, 'scripts/reconcile-deliveries.ts', ...args], {
      env: {},
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 3000,
      killSignal: 'SIGKILL',
    })
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(status).toBe(1)
    expect(stderr).toContain('Usage:')
    expect(stdout + stderr).not.toContain('PRIVATE_INVALID_ID')
    expect(stdout).not.toContain('OPERATOR APPLY')
  })
}
