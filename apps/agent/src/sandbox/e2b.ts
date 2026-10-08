import { sandboxRequestTimeoutMs } from '@vid/config'
import { CommandExitError, FileNotFoundError, E2B, type Sandbox } from 'e2b'
import {
  CapabilityRejectedError,
  type SandboxAssignment,
  type SandboxSessionPort,
  type SandboxTools,
} from '../contract.ts'

export type E2BSandboxOptions = Readonly<{
  apiURL: string
  apiKey: string
  sandboxURL: string
  template: string
  timeoutMs: number
  assignment: SandboxAssignment
  onFailure?: (error: unknown) => void
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
  const { assignment } = options
  if (assignment.nativeRef !== undefined && assignment.nativeRef.provider !== 'e2b')
    throw new Error('Native sandbox provider unavailable; recovery required')
  let remote: Sandbox
  if (assignment.nativeRef === undefined) {
    if (assignment.restoring) throw new Error('Missing prior sandbox; recovery required')
    remote = await client.Sandbox.create(options.template, {
      timeoutMs: options.timeoutMs,
      lifecycle: { onTimeout: 'kill', autoResume: false },
      metadata: {
        platform: 'vid',
        threadID: assignment.threadID,
        runID: assignment.runID,
        fence: String(assignment.fence),
      },
      allowInternetAccess: false,
      network: { allowPublicTraffic: false },
    })
  } else {
    const id = assignment.nativeRef.id
    const checkOwnership = async () => {
      const info = await client.Sandbox.getInfo(id, {
        signal,
        requestTimeoutMs: sandboxRequestTimeoutMs,
      })
      const fence = Number(info.metadata.fence)
      if (
        info.sandboxId !== id ||
        info.metadata.platform !== 'vid' ||
        info.metadata.threadID !== assignment.threadID ||
        !info.metadata.runID ||
        !Number.isSafeInteger(fence) ||
        fence < 1 ||
        (info.metadata.runID === assignment.runID && fence > assignment.fence)
      )
        throw new Error('Sandbox ownership mismatch; recovery required')
      return info
    }
    const info = await checkOwnership()
    if (assignment.restoring) await coldSettle(client, id, signal)
    else if (info.state !== 'paused')
      throw new Error('Prior sandbox is not paused; recovery required')
    signal.throwIfAborted()
    remote = await client.Sandbox.connect(id, {
      timeoutMs: options.timeoutMs,
      onResume: 'reboot',
      signal,
    })
    await verifyConnected(client, id, remote, checkOwnership)
  }
  // Return a known ID even if cancellation arrived during allocation, so the
  // caller can persist it under its cleanup lease before observing the abort.
  return new E2BSandboxSession(remote, signal, options.timeoutMs, options.onFailure)
}

async function verifyConnected(
  client: E2B,
  id: string,
  remote: Sandbox,
  checkOwnership: () => Promise<unknown>,
) {
  try {
    if (remote.sandboxId !== id) throw new Error('Sandbox ownership mismatch; recovery required')
    await checkOwnership()
  } catch (error) {
    // The precheck grants authority only over the assigned ID, never an ID
    // returned by connect or a subsequent ownership response.
    try {
      await coldSettle(client, id)
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Sandbox allocation and cleanup failed')
    }
    throw error
  }
}

async function coldSettle(client: E2B, id: string, signal?: AbortSignal) {
  // Caller holds the exclusive native-storage lock and has stopped the previous
  // worker. Drop the previous guest writer before any native continuation.
  const paused = await client.Sandbox.pause(id, {
    keepMemory: false,
    ...(signal === undefined ? {} : { signal }),
    requestTimeoutMs: sandboxRequestTimeoutMs,
  })
  if (!paused) throw new Error('Prior sandbox pause not confirmed; recovery required')
}

class E2BSandboxSession implements SandboxSessionPort {
  readonly nativeRef
  private closing?: Promise<void>
  private unknownOutcome = false
  private commandCount = 0
  private mutationCount = 0
  private readonly renewalStop = new AbortController()
  private readonly lifetimeFailure = new AbortController()
  private readonly renewal: Promise<void>
  private readonly stopRenewal = () => this.renewalStop.abort()

  constructor(
    private readonly remote: Sandbox,
    private readonly owner: AbortSignal,
    private readonly timeoutMs: number,
    onFailure?: (error: unknown) => void,
  ) {
    this.nativeRef = Object.freeze({ provider: 'e2b', id: remote.sandboxId })
    owner.addEventListener('abort', this.stopRenewal, { once: true })
    this.renewal = this.renewGuest(this.renewalStop.signal, owner).catch((error: unknown) => {
      this.unknownOutcome = true
      this.lifetimeFailure.abort(error)
      this.stopRenewal()
      onFailure?.(error)
    })
    // Failure notification must not leave an unhandled cleanup promise.
    void this.renewal.catch(() => {})
  }

  close(): Promise<void> {
    this.closing ??= this.pause()
    return this.closing
  }

  private async pause() {
    this.stopRenewal()
    this.owner.removeEventListener('abort', this.stopRenewal)
    // Do not cancel an already dispatched control write. Its bounded receipt
    // must settle before pause so a late timeout write cannot revive the guest.
    await this.renewal.catch(() => {})
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
    const cancellation = AbortSignal.any([this.owner, signal, this.lifetimeFailure.signal])
    // Only this local boundary proves no SDK action was invoked. A rejection
    // after action(cancellation) starts remains an unknown mutative outcome.
    if (cancellation.aborted)
      throw new CapabilityRejectedError('Sandbox operation cancelled before dispatch', {
        cause: cancellation.reason,
      })
    if (this.closing !== undefined) throw new CapabilityRejectedError('Sandbox is closing')
    if (this.unknownOutcome)
      throw new Error('Sandbox recovery required: operation outcome uncertain')
    try {
      return await action(cancellation)
    } catch (error) {
      if (mutative) {
        this.unknownOutcome = true
        this.stopRenewal()
      }
      throw error
    }
  }

  async execute({ command, signal }: Parameters<SandboxTools['execute']>[0]) {
    if (!command || command.includes('\0') || Buffer.byteLength(command) > 16 * 1024)
      throw new CapabilityRejectedError('Sandbox command rejected')
    if (this.commandCount >= 8 || this.mutationCount >= 32)
      throw new CapabilityRejectedError('Sandbox mutative quota exceeded')
    this.commandCount++
    this.mutationCount++
    return await this.operation(
      signal,
      (cancellation) => {
        const deadline = AbortSignal.any([cancellation, AbortSignal.timeout(30 * 60 * 1000)])
        return this.executeCommand(command, deadline)
      },
      true,
    )
  }

  private async executeCommand(command: string, deadline: AbortSignal) {
    let outputBytes = 0
    // The SDK retains the current event before callbacks. This caps continued
    // output, not transport frames or peak SDK memory.
    const onOutput = (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk)
      if (outputBytes > 256 * 1024) throw new Error('Sandbox command output limit exceeded')
    }
    const handle = await this.remote.commands.run(command, {
      background: true,
      timeoutMs: 30 * 60 * 1000,
      requestTimeoutMs: sandboxRequestTimeoutMs,
      signal: deadline,
      onStdout: onOutput,
      onStderr: onOutput,
    })
    let killing: Promise<boolean> | undefined
    const abort = () => {
      // A lost command acknowledgement is not authority to extend guest life
      // while its bounded kill/disconnect cleanup is still being joined.
      this.stopRenewal()
      killing ??= this.remote.commands.kill(handle.pid, {
        requestTimeoutMs: sandboxRequestTimeoutMs,
      })
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
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode }
    } finally {
      deadline.removeEventListener('abort', abort)
      try {
        await killing
      } finally {
        await handle.disconnect()
      }
    }
  }

  private async renewGuest(stop: AbortSignal, owner: AbortSignal) {
    while (!stop.aborted && !owner.aborted) {
      await new Promise<void>((resolve) => {
        const signal = AbortSignal.any([stop, owner])
        const done = () => {
          clearTimeout(timer)
          signal.removeEventListener('abort', done)
          resolve()
        }
        const timer = setTimeout(done, Math.max(1, Math.floor(this.timeoutMs / 3)))
        signal.addEventListener('abort', done, { once: true })
        if (signal.aborted) done()
      })
      if (stop.aborted || owner.aborted || this.unknownOutcome || this.closing !== undefined) return
      await this.remote.setTimeout(this.timeoutMs, {
        requestTimeoutMs: Math.min(
          sandboxRequestTimeoutMs,
          Math.max(1, Math.floor(this.timeoutMs / 3)),
        ),
      })
    }
  }

  private validatePath(path: string) {
    if (!path || path.includes('\0') || Buffer.byteLength(path) > 4096)
      throw new CapabilityRejectedError('Sandbox path rejected')
  }

  private reserveWrite(path: string, bytes: number) {
    this.validatePath(path)
    if (bytes > 32 * 1024 * 1024 || this.mutationCount >= 32)
      throw new CapabilityRejectedError('Sandbox mutative quota exceeded')
    this.mutationCount++
  }

  async read({ path, signal }: Parameters<SandboxTools['read']>[0]) {
    return new TextDecoder().decode(await this.readBytes(path, signal, 256 * 1024))
  }

  async write({ path, content, signal }: Parameters<SandboxTools['write']>[0]) {
    if (Buffer.byteLength(content) > 256 * 1024)
      throw new CapabilityRejectedError('Sandbox write byte limit exceeded')
    this.reserveWrite(path, Buffer.byteLength(content))
    await this.operation(
      signal,
      (cancellation) =>
        this.remote.files.write(path, content, {
          signal: cancellation,
          requestTimeoutMs: sandboxRequestTimeoutMs,
        }),
      true,
    )
  }

  async readBytes(path: string, signal: AbortSignal, maxBytes: number) {
    this.validatePath(path)
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 32 * 1024 * 1024)
      throw new CapabilityRejectedError('Sandbox read budget rejected')
    return await this.operation(
      AbortSignal.any([signal, AbortSignal.timeout(sandboxRequestTimeoutMs)]),
      async (cancellation) => {
        const stream = await this.remote.files
          .read(path, {
            format: 'stream',
            signal: cancellation,
            requestTimeoutMs: sandboxRequestTimeoutMs,
          })
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
      },
    )
  }

  async writeBytes(path: string, bytes: Uint8Array, signal: AbortSignal) {
    this.reserveWrite(path, bytes.byteLength)
    const buffer = new ArrayBuffer(bytes.byteLength)
    new Uint8Array(buffer).set(bytes)
    await this.operation(
      signal,
      (cancellation) =>
        this.remote.files.write(path, buffer, {
          signal: cancellation,
          requestTimeoutMs: sandboxRequestTimeoutMs,
        }),
      true,
    )
  }
}
