import { expect, test } from 'bun:test'
import { startAdministrationChild } from './administration-process-fixture'

for (const hang of [false, true]) {
  test(`administrative child ${hang ? 'hard-stops' : 'normally settles'} both real diagnostic pipes`, async () => {
    const source = hang
      ? "process.on('SIGTERM', () => {}); process.stdout.write('o'.repeat(131072)); process.stderr.write('e'.repeat(131072)); setInterval(() => {}, 1000)"
      : "process.stdout.write('output 🎬'); process.stderr.write('diagnostic')"
    const started = performance.now()
    const child = startAdministrationChild(
      [process.execPath, '--eval', source],
      process.env,
      hang ? 200 : 1000,
    )
    const failures: unknown[] = []
    try {
      const result = await child.result()
      if (hang) {
        expect(performance.now() - started).toBeLessThan(400)
        expect(child.child.signalCode).toBe('SIGKILL')
        expect(result.stdout.length).toBeGreaterThanOrEqual(65536)
        expect(result.stderr.length).toBeGreaterThanOrEqual(65536)
      } else {
        expect(result).toEqual({
          code: 0,
          stdout: 'output 🎬',
          stderr: 'diagnostic',
        })
        expect(child.child.signalCode).toBeNull()
      }
    } catch (cause) {
      failures.push(cause)
    }
    failures.push(...(await child.stop()))
    expect(child.child.exitCode !== null || child.child.signalCode !== null).toBeTrue()
    if (failures.length) throw new AggregateError(failures, 'Diagnostic pipe probe failed')
  })
}
