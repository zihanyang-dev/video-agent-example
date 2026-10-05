import { boundedBytes } from '@vid/object-storage'
import { CommandExitError, E2B, type Sandbox, type CommandHandle } from 'e2b'
import type {
  ExecutionLease,
  SandboxSessionPort,
  SandboxTools,
  SandboxFiles,
} from '../execute-run'

export type E2BSandboxOptions = Readonly<{
  apiURL: string
  apiKey: string
  sandboxURL: string
  template: string
  timeoutMs: number
  lease: ExecutionLease
}>

/** Never retry an unknown allocation ACK. The caller quarantines even a null
 * reference. Retained timeout-kill is a backstop, not persistence assurance. */
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
    requestTimeoutMs: 10000,
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
  // A cancellation arriving during create/connect still returns the known ID:
  // execution persists it under its cleanup lease before checking abort.
  return new E2BSandboxSession(remote, signal, options.timeoutMs)
}

/** Foreground RPC promises settle before native filesystem-only pause. Unknown
 * RPC/pause outcomes still quarantine: pause is not external job cancellation.
 * SDK command kill only addresses a PID, not its process group. */
class E2BSandboxSession
  implements SandboxSessionPort, SandboxTools, SandboxFiles
{
  readonly tools: SandboxTools = this
  readonly files: SandboxFiles = this
  readonly nativeRef
  private closing?: Promise<void>
  private readonly pending = new Set<Promise<unknown>>()
  private unknownOutcome = false

  constructor(
    private readonly remote: Sandbox,
    private readonly owner: AbortSignal,
    private readonly timeoutMs: number,
  ) {
    this.nativeRef = { provider: 'e2b', id: remote.sandboxId }
  }

  close(): Promise<void> {
    this.closing ??= this.pause()
    return this.closing
  }

  async renewTimeout() {
    if (this.closing !== undefined) return
    const request = this.remote.setTimeout(this.timeoutMs, {
      requestTimeoutMs: 10000,
    })
    this.pending.add(request)
    try {
      await request
    } catch (error) {
      this.unknownOutcome = true
      throw error
    } finally {
      this.pending.delete(request)
    }
  }

  private async pause() {
    await Promise.allSettled(this.pending)
    const paused = await this.remote.pause({
      keepMemory: false,
      requestTimeoutMs: 10000,
    })
    // false may describe a preexisting RAM snapshot, not a conversion to disk-only.
    if (!paused || this.unknownOutcome)
      throw new Error(
        'Sandbox recovery required: pause or command outcome uncertain',
      )
  }

  private async operation<Outcome>(
    signal: AbortSignal,
    action: (signal: AbortSignal) => Promise<Outcome>,
    uncertainOnAbort = false,
  ) {
    const cancellation = AbortSignal.any([this.owner, signal])
    cancellation.throwIfAborted()
    if (this.closing !== undefined) throw new Error('Sandbox is settling')
    if (this.unknownOutcome)
      throw new Error('Sandbox recovery required: operation outcome uncertain')
    const request = action(cancellation)
    this.pending.add(request)
    try {
      return await request
    } catch (error) {
      // A cancelled file upload can already have committed remotely. Only
      // foreground commands have the separate owned PID settlement guarantee.
      if (uncertainOnAbort || error !== cancellation.reason)
        this.unknownOutcome = true
      throw error
    } finally {
      this.pending.delete(request)
    }
  }

  async execute({ command, signal }: Parameters<SandboxTools['execute']>[0]) {
    return await this.operation(signal, async (cancellation) => {
      // Starting with no abort signal avoids detaching the foreground stream.
      // If start's ACK is lost, operation() quarantines; never start it again.
      const handle = await this.remote.commands.run(command, {
        background: true,
        timeoutMs: this.timeoutMs,
        requestTimeoutMs: 10000,
      })
      let killing: Promise<boolean> | undefined
      const abort = () => {
        killing ??= handle.kill()
        void killing.catch(() => {}) // awaited below, never detached cleanup
      }
      cancellation.addEventListener('abort', abort, { once: true })
      if (cancellation.aborted) abort()
      try {
        const completed = await commandCompletion(handle)
        if (killing !== undefined) await killing
        cancellation.throwIfAborted()
        return {
          stdout: completed.stdout,
          stderr: completed.stderr,
          exitCode: completed.exitCode,
        }
      } finally {
        cancellation.removeEventListener('abort', abort)
        if (killing !== undefined) await killing
      }
    })
  }

  async read({ path, signal }: Parameters<SandboxTools['read']>[0]) {
    return await this.operation(signal, (cancellation) =>
      this.remote.files.read(path, { signal: cancellation }),
    )
  }

  async write({ path, content, signal }: Parameters<SandboxTools['write']>[0]) {
    await this.operation(
      signal,
      (cancellation) =>
        this.remote.files.write(path, content, { signal: cancellation }),
      true,
    )
  }

  async readBytes(path: string, signal: AbortSignal, maxBytes: number) {
    return await this.operation(signal, async (cancellation) => {
      const stream = await this.remote.files.read(path, {
        format: 'stream',
        signal: cancellation,
      })
      return await boundedBytes(stream, maxBytes)
    })
  }

  async writeBytes(path: string, bytes: Uint8Array, signal: AbortSignal) {
    const buffer = new ArrayBuffer(bytes.byteLength)
    new Uint8Array(buffer).set(bytes)
    await this.operation(
      signal,
      (cancellation) =>
        this.remote.files.write(path, buffer, { signal: cancellation }),
      true,
    )
  }
}

async function commandCompletion(handle: CommandHandle) {
  try {
    return await handle.wait()
  } catch (error) {
    if (!(error instanceof CommandExitError)) throw error
    return error
  }
}
