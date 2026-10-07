import { sandboxRequestTimeoutMs } from '@vid/config'
import { CommandExitError, FileNotFoundError, E2B, type Sandbox } from 'e2b'
import type { ExecutionLease, SandboxSessionPort, SandboxTools } from '../execution/contract'

export type E2BSandboxOptions = Readonly<{
  apiURL: string
  apiKey: string
  sandboxURL: string
  template: string
  timeoutMs: number
  lease: ExecutionLease
}>

/** An unknown allocation acknowledgement must never be retried. */
export async function openE2BSandbox(
  options: E2BSandboxOptions,
  signal: AbortSignal,
): Promise<SandboxSessionPort> {
  signal.throwIfAborted()
  const client = new E2B({
    apiUrl: options.apiURL,
    apiKey: options.apiKey,
    sandboxUrl: options.sandboxURL,
    debug: false,
    retries: 0,
    requestTimeoutMs: sandboxRequestTimeoutMs,
  })
  const { lease } = options
  if (lease.nativeRef !== undefined && lease.nativeRef.provider !== 'e2b')
    throw new Error('Native sandbox provider unavailable; recovery required')
  const remote =
    lease.nativeRef === undefined
      ? await client.Sandbox.create(options.template, {
          timeoutMs: options.timeoutMs,
          lifecycle: { onTimeout: 'kill', autoResume: false },
          metadata: {
            platform: 'vid',
            threadID: lease.threadID,
            runID: lease.runID,
            fence: String(lease.fence),
          },
          allowInternetAccess: false,
          network: { allowPublicTraffic: false },
        })
      : await client.Sandbox.connect(lease.nativeRef.id, {
          timeoutMs: options.timeoutMs,
          onResume: 'reboot',
        })
  // Return a known ID even if cancellation arrived during allocation, so the
  // caller can persist it under its cleanup lease before observing the abort.
  return new E2BSandboxSession(remote, signal, options.timeoutMs)
}

class E2BSandboxSession implements SandboxSessionPort {
  readonly nativeRef
  private closing?: Promise<void>
  private unknownOutcome = false

  constructor(
    private readonly remote: Sandbox,
    private readonly owner: AbortSignal,
    private readonly timeoutMs: number,
  ) {
    this.nativeRef = Object.freeze({ provider: 'e2b', id: remote.sandboxId })
  }

  close(): Promise<void> {
    this.closing ??= this.pause()
    return this.closing
  }

  private async pause() {
    const paused = await this.remote.pause({
      keepMemory: false,
      requestTimeoutMs: sandboxRequestTimeoutMs,
    })
    if (!paused || this.unknownOutcome)
      throw new Error('Sandbox recovery required: mutative outcome uncertain')
  }

  private async operation<Outcome>(
    signal: AbortSignal,
    action: (signal: AbortSignal) => Promise<Outcome>,
    mutative = false,
  ) {
    const cancellation = AbortSignal.any([this.owner, signal])
    cancellation.throwIfAborted()
    if (this.closing !== undefined) throw new Error('Sandbox is closing')
    if (this.unknownOutcome)
      throw new Error('Sandbox recovery required: operation outcome uncertain')
    try {
      return await action(cancellation)
    } catch (error) {
      if (mutative) this.unknownOutcome = true
      throw error
    }
  }

  async execute({ command, signal }: Parameters<SandboxTools['execute']>[0]) {
    return await this.operation(
      signal,
      async (cancellation) => {
        const deadline = AbortSignal.any([cancellation, AbortSignal.timeout(this.timeoutMs)])
        let outputBytes = 0
        // The official SDK retains the current decoded event before callbacks.
        // This caps continued output, not transport frames or peak SDK memory.
        const onOutput = (chunk: string) => {
          outputBytes += Buffer.byteLength(chunk)
          if (outputBytes > 256 * 1024) throw new Error('Sandbox command output limit exceeded')
        }
        const handle = await this.remote.commands.run(command, {
          background: true,
          timeoutMs: this.timeoutMs,
          requestTimeoutMs: sandboxRequestTimeoutMs,
          signal: deadline,
          onStdout: onOutput,
          onStderr: onOutput,
        })
        let killing: Promise<boolean> | undefined
        const abort = () => {
          killing ??= handle.kill()
          void killing.catch(() => {})
        }
        deadline.addEventListener('abort', abort, { once: true })
        if (deadline.aborted) abort()
        try {
          const result = await handle.wait().catch((error: unknown) => {
            if (error instanceof CommandExitError) return error
            abort()
            throw error
          })
          deadline.throwIfAborted()
          return {
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
          }
        } finally {
          deadline.removeEventListener('abort', abort)
          try {
            await killing
          } finally {
            await handle.disconnect()
          }
        }
      },
      true,
    )
  }

  async read({ path, signal }: Parameters<SandboxTools['read']>[0]) {
    return new TextDecoder().decode(await this.readBytes(path, signal, 256 * 1024))
  }

  async write({ path, content, signal }: Parameters<SandboxTools['write']>[0]) {
    await this.operation(
      signal,
      (cancellation) => this.remote.files.write(path, content, { signal: cancellation }),
      true,
    )
  }

  async readBytes(path: string, signal: AbortSignal, maxBytes: number) {
    return await this.operation(signal, async (cancellation) => {
      const stream = await this.remote.files
        .read(path, { format: 'stream', signal: cancellation })
        .catch((error: unknown) => {
          if (error instanceof FileNotFoundError) throw new Error('Sandbox file not found')
          throw error
        })
      const reader = stream.getReader()
      const chunks: Uint8Array[] = []
      let length = 0
      try {
        let next = await reader.read()
        while (!next.done && length + next.value.byteLength <= maxBytes) {
          length += next.value.byteLength
          chunks.push(next.value)
          next = await reader.read()
        }
        if (!next.done) throw new Error('Sandbox file byte limit exceeded')
        return Buffer.concat(chunks, length)
      } finally {
        try {
          await reader.cancel()
        } finally {
          reader.releaseLock()
        }
      }
    })
  }

  async writeBytes(path: string, bytes: Uint8Array, signal: AbortSignal) {
    const buffer = new ArrayBuffer(bytes.byteLength)
    new Uint8Array(buffer).set(bytes)
    await this.operation(
      signal,
      (cancellation) => this.remote.files.write(path, buffer, { signal: cancellation }),
      true,
    )
  }
}
