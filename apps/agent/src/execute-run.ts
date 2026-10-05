import type { AssetReference } from '@vid/contract/execution'
import type { NativeSandboxReference } from './sandbox/reference'

export type { NativeSandboxReference } from './sandbox/reference'

/** A database-issued execution capability. The fence/owner must remain valid for every write. */
export type ExecutionLease = Readonly<{
  runID: string
  threadID: string
  commandID: string
  messageID: string
  text: string
  fence: number
  ownerID: string
  history: unknown
  assets?: readonly AssetReference[]
  nativeRef?: NativeSandboxReference
}>

/** Tool operations address only the worker-assigned sandbox, never a host path or container ID. */
export interface SandboxTools {
  /** Owns foreground abort and settlement; unknown mutative outcomes reject.
   * Does not promise process-tree or external paid-job cancellation. */
  execute: (
    request: Readonly<{ command: string; signal: AbortSignal }>,
  ) => Promise<Readonly<{ stdout: string; stderr: string; exitCode: number }>>
  read: (
    request: Readonly<{ path: string; signal: AbortSignal }>,
  ) => Promise<string>
  write: (
    request: Readonly<{ path: string; content: string; signal: AbortSignal }>,
  ) => Promise<void>
}

/** Vendor-independent business capabilities of the lease-assigned sandbox session,
 * not a provider registry or a replica of the native SDK surface. */
export interface SandboxSessionPort {
  tools: SandboxTools
  /** Opaque native identity; execution persists it without interpreting provider details. */
  nativeRef: NativeSandboxReference
  /** Awaits owned foreground/RPC settlement and filesystem-only pause; unknown
   * outcomes reject. Neither external job cancellation nor durable artifact proof. */
  close: () => Promise<void>
  /** Extends the assigned VM's TTL, not the database execution lease. */
  renewTimeout: () => Promise<void>
  files: SandboxFiles
}

export interface SandboxFiles {
  readBytes: (
    path: string,
    signal: AbortSignal,
    maxBytes: number,
  ) => Promise<Uint8Array>
  writeBytes: (
    path: string,
    bytes: Uint8Array,
    signal: AbortSignal,
  ) => Promise<void>
}

export interface AgentHarness {
  /** Settlement owns Pi abort and all tool operations, including after signal abort. */
  turn: (
    request: Readonly<{
      text: string
      history: unknown
      tools: SandboxTools
      signal: AbortSignal
      fileTools?: FileTools
      images?: readonly Readonly<{ bytes: Uint8Array; mimeType: string }>[]
      onText: (delta: string) => void
    }>,
  ) => Promise<Readonly<{ text: string; history: unknown }>>
}

export type ExecutionFailure = 'execution-error' | 'interrupted'
export type ExecutionCompletion = {
  text: string
  history: unknown
  assets?: readonly AssetReference[]
}

export interface ExecutionWrites {
  saveSandbox: (
    lease: ExecutionLease,
    reference: NativeSandboxReference,
  ) => Promise<boolean>
  quarantine: (
    lease: ExecutionLease,
    reason?: ExecutionFailure,
  ) => Promise<void>

  renew: (
    lease: ExecutionLease,
    leaseMs: number,
  ) => Promise<'renewed' | 'cancel' | 'lost' | 'recovery-required'>
  appendText: (lease: ExecutionLease, delta: string) => Promise<boolean>

  complete: (
    lease: ExecutionLease,
    completion: ExecutionCompletion,
  ) => Promise<boolean>
  fail: (lease: ExecutionLease, reason: ExecutionFailure) => Promise<boolean>
  cancel: (lease: ExecutionLease) => Promise<boolean>
}

/** Per-run file authority; the harness implements it, execution owns its result. */
export interface FileTools {
  assigned: readonly AssetReference[]
  prepared: readonly AssetReference[]
  importFile: (request: {
    assetID: string
    path: string
    signal: AbortSignal
  }) => Promise<{ bytes: Uint8Array; mimeType: string }>
  exportFile: (request: {
    path: string
    name: string
    mimeType: string
    signal: AbortSignal
  }) => Promise<AssetReference>
  hasUnknownOutcome: () => boolean
}

export type ExecuteRunDependencies = Readonly<{
  writes: ExecutionWrites
  fileTools?: (
    lease: ExecutionLease,
    sandbox: SandboxSessionPort,
    stopSpending: () => void,
  ) => FileTools
  harness: AgentHarness
  /** The assigned allocator owns connection settings and awaits failed-allocation cleanup. */
  openSandbox: (
    lease: ExecutionLease,
    signal: AbortSignal,
  ) => Promise<SandboxSessionPort>
}>

export type ExecuteRunOptions = Readonly<{
  leaseMs: number
  pollMs: number
  /** Worker shutdown, not the database's cancellation authority. */
  signal: AbortSignal
}>

export type ExecutionOutcome = 'completed' | 'cancelled' | 'failed' | 'lost'
type StopReason = 'cancel' | 'lost' | 'execution-error' | 'interrupted'
type SettledTurn = Readonly<ExecutionCompletion> | undefined
type Execution = {
  readonly lease: ExecutionLease
  readonly deps: ExecuteRunDependencies
  readonly options: ExecuteRunOptions
  readonly controller: AbortController
  reason?: StopReason
  acceptingText: boolean
  textWrites: Promise<void>
  // Allocation owns close; heartbeat may renew this capability until settlement.
  nativeSandbox?: SandboxSessionPort
  needsRecovery: boolean
  lastTimeoutRenewal: number
}

function stop(execution: Execution, reason: StopReason) {
  // Fencing loss dominates: this worker must never attempt a stale terminal mutation.
  if (execution.reason === 'lost') return
  if (
    execution.reason === undefined ||
    reason === 'lost' ||
    reason === 'execution-error' ||
    (reason === 'cancel' && execution.reason === 'interrupted')
  ) {
    execution.reason = reason
  }
  if (reason === 'lost' || reason === 'execution-error')
    execution.needsRecovery = true
  execution.controller.abort()
}

async function renew(execution: Execution) {
  try {
    const status = await execution.deps.writes.renew(
      execution.lease,
      execution.options.leaseMs,
    )
    if (status !== 'renewed')
      stop(
        execution,
        status === 'recovery-required' ? 'execution-error' : status,
      )
    if (
      status !== 'lost' &&
      execution.nativeSandbox !== undefined &&
      Date.now() - execution.lastTimeoutRenewal >= execution.options.leaseMs / 2
    ) {
      await execution.nativeSandbox.renewTimeout()
      execution.lastTimeoutRenewal = Date.now()
    }
  } catch {
    // Unknown database outcome is not permission to keep spending or replay a turn.
    stop(execution, 'execution-error')
  }
}

function waitForPoll(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    signal.addEventListener('abort', finish, { once: true })
    if (signal.aborted) finish()
  })
}

async function heartbeat(execution: Execution, signal: AbortSignal) {
  // Abort stops spending, not ownership: settlement still owns Pi/tools, remote
  // pause and queued writes. Only fence loss ends renewal before settlement.
  while (!signal.aborted && execution.reason !== 'lost') {
    await waitForPoll(execution.options.pollMs, signal)
    if (signal.aborted) return
    await renew(execution)
  }
}

function enqueueText(execution: Execution, delta: string) {
  if (!execution.acceptingText || execution.reason !== undefined) return
  execution.textWrites = execution.textWrites.then(async () => {
    if (execution.reason !== undefined) return
    try {
      const appended = await execution.deps.writes.appendText(
        execution.lease,
        delta,
      )
      if (!appended) {
        // appendText also rejects a still-owned cancelled run. Stop spending now,
        // then ask the lease authority which terminal action is permitted.
        execution.controller.abort()
        await renew(execution)
        stop(execution, execution.reason ?? 'lost')
      }
    } catch {
      // Synchronous onText cannot await. Retain failure as the run's outcome and
      // abort immediately; the owner drains every queued write before terminal.
      stop(execution, 'execution-error')
    }
  })
}

async function executeAssignedTurn(execution: Execution): Promise<SettledTurn> {
  let sandbox: SandboxSessionPort | undefined
  let fileTools: FileTools | undefined
  let turnProduct: SettledTurn
  try {
    execution.controller.signal.throwIfAborted()
    sandbox = await execution.deps.openSandbox(
      execution.lease,
      execution.controller.signal,
    )
    execution.nativeSandbox = sandbox
    const saved = await execution.deps.writes.saveSandbox(
      execution.lease,
      sandbox.nativeRef,
    )
    if (!saved) {
      await renew(execution)
      stop(execution, execution.reason ?? 'lost')
      return
    }
    if (execution.deps.fileTools !== undefined)
      fileTools = execution.deps.fileTools(execution.lease, sandbox, () =>
        stop(execution, 'execution-error'),
      )
    execution.controller.signal.throwIfAborted()
    const tools = sandbox.tools
    execution.acceptingText = true
    const turn = await execution.deps.harness.turn({
      text: execution.lease.text,
      history: execution.lease.history,
      tools: {
        execute: (request) =>
          executeToolOperation(execution, () => tools.execute(request)),
        read: (request) =>
          executeToolOperation(execution, () => tools.read(request)),
        write: (request) =>
          executeToolOperation(execution, () => tools.write(request)),
      },
      signal: execution.controller.signal,
      ...(fileTools === undefined ? {} : { fileTools }),
      onText: (delta) => enqueueText(execution, delta),
    })
    execution.acceptingText = false
    execution.controller.signal.throwIfAborted()
    turnProduct = {
      text: turn.text,
      history: turn.history,
      ...(fileTools === undefined ? {} : { assets: fileTools.prepared }),
    }
  } catch (error) {
    // The owner's abort reason is expected interruption. A distinct rejection
    // (including allocation/turn abort cleanup failure) remains an execution error.
    if (
      !execution.controller.signal.aborted ||
      error !== execution.controller.signal.reason
    ) {
      stop(execution, 'execution-error')
    }
  } finally {
    // turn's promise owns Pi abort/tool settlement. Never race it against abort.
    execution.acceptingText = false
    await settleResources(execution, sandbox, fileTools)
  }
  // Cleanup and queued writes can stop an otherwise successful turn. The stop
  // reason retains terminal authority; only a settled success carries products.
  return execution.reason === undefined ? turnProduct : undefined
}

async function settleResources(
  execution: Execution,
  sandbox: SandboxSessionPort | undefined,
  fileTools: FileTools | undefined,
) {
  try {
    await sandbox?.close()
    if (fileTools?.hasUnknownOutcome()) stop(execution, 'execution-error')
  } catch {
    // A remote TTL is only an orphan backstop, not successful cleanup.
    stop(execution, 'execution-error')
  } finally {
    // Closing the sandbox cannot detach a database write already in flight.
    await execution.textWrites
  }
}

async function settleRacingCancellation(
  execution: Execution,
): Promise<ExecutionOutcome> {
  // Re-authorize only cancellation after a rejected terminal write. Never retry
  // completion/failure or override a true fencing loss.
  await renew(execution)
  if (execution.reason === 'cancel') {
    if (await execution.deps.writes.cancel(execution.lease)) return 'cancelled'
    // Recovery can arrive between reauthorization and cancellation too.
    await renew(execution)
  }
  return 'lost'
}

async function finishExecution(
  execution: Execution,
  turnProduct: SettledTurn,
): Promise<ExecutionOutcome> {
  const { lease, deps, reason } = execution
  if (reason === 'lost') return 'lost'
  if (reason === 'cancel') {
    if (await deps.writes.cancel(lease)) return 'cancelled'
    await renew(execution)
    return 'lost'
  }
  if (reason !== undefined) {
    if (await deps.writes.fail(lease, reason)) return 'failed'
    // Database cancellation may race shutdown's last poll. Re-authorize only
    // cancellation; never override it with a stale interruption or retry failure.
    return await settleRacingCancellation(execution)
  }
  if (turnProduct === undefined)
    throw new Error('Execution settled without a turn result')
  // An unknown commit outcome must retain uploaded objects: deleting here could
  // break an asset reference that PostgreSQL actually committed. Unreferenced
  // immutable objects require separately authorized operator reconciliation.
  const completed = await deps.writes.complete(lease, turnProduct)
  if (completed) return 'completed'
  // Cancellation may arrive between the last poll and the fenced completion.
  // Re-authorize cancellation only; never retry a rejected completion.
  return await settleRacingCancellation(execution)
}

/** Executes exactly one claimed run. Never retries allocation, inference or terminal writes. */
export async function executeRun(
  lease: ExecutionLease,
  deps: ExecuteRunDependencies,
  options: ExecuteRunOptions,
): Promise<ExecutionOutcome> {
  const execution: Execution = {
    lease,
    deps,
    options,
    controller: new AbortController(),
    acceptingText: false,
    textWrites: Promise.resolve(),
    needsRecovery: false,
    lastTimeoutRenewal: Date.now(),
  }
  const shutdown = () => stop(execution, 'interrupted')
  const monitoring = new AbortController()
  options.signal.addEventListener('abort', shutdown, { once: true })
  if (options.signal.aborted) shutdown()
  try {
    // Authorize before allocation; then retain ownership during allocation, turn,
    // queued writes and native pause, including slow abort cleanup.
    await renew(execution)
    const polling = heartbeat(execution, monitoring.signal)
    try {
      const turnProduct = await executeAssignedTurn(execution)
      monitoring.abort()
      await polling
      return await finishWithRecovery(execution, turnProduct)
    } finally {
      monitoring.abort()
      await polling
    }
  } finally {
    options.signal.removeEventListener('abort', shutdown)
  }
}

async function executeToolOperation<Outcome>(
  execution: Execution,
  operation: () => Promise<Outcome>,
) {
  try {
    execution.controller.signal.throwIfAborted()
    return await operation()
  } catch (error) {
    // Pi normally exposes tool failures to the model. Unknown VM outcomes must
    // instead stop the session, before any automatic next inference.
    if (error !== execution.controller.signal.reason)
      stop(execution, 'execution-error')
    throw error
  }
}

async function finishWithRecovery(
  execution: Execution,
  turnProduct: SettledTurn,
): Promise<ExecutionOutcome> {
  const { deps, lease } = execution
  if (execution.needsRecovery) {
    await deps.writes.quarantine(
      lease,
      execution.reason === 'execution-error'
        ? 'execution-error'
        : 'interrupted',
    )
    return execution.reason === 'lost' ? 'lost' : 'failed'
  }
  let outcome: ExecutionOutcome
  try {
    outcome = await finishExecution(execution, turnProduct)
  } catch (error) {
    // A lost COMMIT acknowledgement is not permission to reuse the VM.
    await deps.writes.quarantine(lease)
    throw error
  }
  // Rejected terminal writes reauthorize after the initial recovery check.
  // An unknown renewal or newly observed quarantine must settle before return.
  if (execution.needsRecovery) {
    await deps.writes.quarantine(
      lease,
      execution.reason === 'execution-error'
        ? 'execution-error'
        : 'interrupted',
    )
    return execution.reason === 'lost' ? 'lost' : 'failed'
  }
  return outcome
}
