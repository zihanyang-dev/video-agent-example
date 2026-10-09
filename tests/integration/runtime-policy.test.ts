import { expect, test } from 'bun:test'

// The observer owns the PID and both pipes. No failure-path resource disposal
// is authorized until child.exited and pipe joins have completed.
async function observe(scenario: string) {
  const child = Bun.spawn(
    [process.execPath, 'test', './tests/integration/runtime-policy-childfixture.ts'],
    {
      env: { ...process.env, VID_RUNTIME_POLICY_SCENARIO: scenario },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  let observerFailure: string | undefined
  const deadline = setTimeout(() => {
    observerFailure = 'Child exceeded observer deadline'
    child.kill('SIGKILL')
  }, 8000)
  async function drain(pipe: ReadableStream<Uint8Array>) {
    const reader = pipe.getReader()
    const decoder = new TextDecoder()
    let output = ''
    async function readAll() {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        output += decoder.decode(value, { stream: true })
        if (output.length > 65536) {
          observerFailure = 'Child exceeded pipe cap'
          child.kill('SIGKILL')
          output = output.slice(0, 65536)
        }
      }
      return output + decoder.decode()
    }
    return await readAll().finally(() => reader.releaseLock())
  }
  const stdout = drain(child.stdout)
  const stderr = drain(child.stderr)
  try {
    const exit = await child.exited
    const output = (await stdout) + (await stderr)
    if (observerFailure) throw new Error(`${observerFailure}\n${output}`)
    return { exit, output }
  } finally {
    child.kill('SIGKILL')
    await child.exited
    await Promise.all([stdout, stderr])
    clearTimeout(deadline)
  }
}

for (const { scenario, cause } of [
  { scenario: 'bodytimeout', cause: 'body still pending after Bun timeout' },
  { scenario: 'bodyrejection', cause: 'original body rejection cause' },
  { scenario: 'partialstartup', cause: 'original partial startup cause' },
  { scenario: 'finallyerror', cause: 'original finally cleanup cause' },
  { scenario: 'hookrejection', cause: 'runtime_policy_missing_function' },
  { scenario: 'hookhang', cause: 'SQL hook cleanup deadline' },
]) {
  test(`runtime policy fail-stops ${scenario}`, async () => {
    const { exit, output } = await observe(scenario)
    expect(exit).toBe(1)
    expect(output).toContain(`runtime policy ${scenario}`)
    expect(output).toContain('http-resource-acquired')
    expect(output).toContain(cause)
    expect(output).not.toContain('next-acquisition')
    expect(output).not.toContain('sql-hook-completed')
    if (scenario.startsWith('hook')) {
      expect(output).toContain('sql-hook-entered')
    } else {
      expect(output).not.toContain('sql-hook-entered')
    }
    if (scenario === 'bodytimeout') {
      expect(output).toContain('300ms')
      expect(output).not.toContain('body-finally')
    }
    if (scenario === 'partialstartup') expect(output).not.toContain('body-finally')
  }, 10000)
}

test('runtime policy permits normal body and SQL hook completion', async () => {
  const { exit, output } = await observe('normal')
  expect(exit).toBe(0)
  expect(output).toContain('body-finally')
  expect(output).toContain('sql-hook-completed')
  expect(output).toContain('next-acquisition')
  expect(output).not.toContain('fail-stop')
}, 10000)
