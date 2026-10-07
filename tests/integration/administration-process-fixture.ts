function output(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let active = true
  let cancellation: Promise<void> | undefined
  async function read() {
    let text = ''
    let size = 0
    let chunk = await reader.read()
    while (!chunk.done) {
      size += chunk.value.byteLength
      if (size > 16 * 1024 * 1024) throw new Error('Owned diagnostic output exceeded')
      text += decoder.decode(chunk.value, { stream: true })
      chunk = await reader.read()
    }
    return text + decoder.decode()
  }
  const result = read().finally(() => {
    active = false
    reader.releaseLock()
  })
  return {
    result,
    async cancel() {
      if (active) await (cancellation ??= reader.cancel())
    },
  }
}

/** This fixture owns exactly one administrative child and both diagnostic pipes. */
export function startAdministrationChild(
  command: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 3500,
) {
  const child = Bun.spawn(command, {
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
  })
  const stdout = output(child.stdout)
  const stderr = output(child.stderr)
  const failures: unknown[] = []
  let forced = false
  let reported: number | undefined
  let cancelling: Promise<PromiseSettledResult<void>[]> | undefined
  const cancel = () => (cancelling ??= Promise.allSettled([stdout.cancel(), stderr.cancel()]))
  function kill() {
    if (child.exitCode !== null || child.signalCode !== null) return
    try {
      child.kill('SIGKILL')
    } catch (cause) {
      failures.push(cause)
    }
  }
  let deadline: ReturnType<typeof setTimeout>
  const settled = Promise.allSettled([child.exited, stdout.result, stderr.result]).then(
    (results) => {
      clearTimeout(deadline)
      return results
    },
  )
  deadline = setTimeout(() => {
    forced = true
    kill()
    void cancel()
  }, timeoutMs)
  return {
    child,
    get forced() {
      return forced
    },
    async result() {
      const [exit, out, err] = await settled
      if (exit.status === 'rejected') {
        reported = 0
        throw exit.reason
      }
      if (out.status === 'rejected') {
        reported = 1
        throw out.reason
      }
      if (err.status === 'rejected') {
        reported = 2
        throw err.reason
      }
      return { code: exit.value, stdout: out.value, stderr: err.value }
    },
    async stop() {
      kill()
      const cancellations = await cancel()
      const results = await settled
      for (const result of cancellations)
        if (result.status === 'rejected') failures.push(result.reason)
      results.forEach((result, index) => {
        if (result.status === 'rejected' && index !== reported) failures.push(result.reason)
      })
      return failures
    },
  }
}
