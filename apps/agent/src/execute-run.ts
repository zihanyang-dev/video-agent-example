import { HistoryLimitError } from './harness/pi-history'
import type { WebSource } from '@vid/contract/web-source'
import type { AssetReference } from '@vid/contract/execution'
import type { NativeSandboxReference } from './sandbox/reference'

/** A database-issued execution capability. The fence/owner must remain valid for every write. */
export type ExecutionLease = Readonly<{
  runID: string
  threadID: string
  text: string
  fence: number
  ownerID: string
  history: unknown
  assets?: readonly AssetReference[]
  nativeRef?: NativeSandboxReference
}>

/** Tool operations address only the worker-assigned sandbox, never a host path or container ID. */
export interface SandboxTools {
  /** Uses supported command abort/kill; unknown mutative outcomes reject.
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
export interface SandboxSessionPort extends SandboxTools, SandboxFiles {
  /** Opaque native identity; execution persists it without interpreting provider details. */
  nativeRef: NativeSandboxReference
  /** Pauses after the caller finishes its tools; unknown mutative outcomes reject. Neither external job cancellation nor durable artifact proof. */
  close: () => Promise<void>
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
  /** Uses bounded Pi abort and cleanup, without remote settlement guarantees. */
  turn: (
    request: Readonly<{
      text: string
      history: unknown
      tools: SandboxTools
      signal: AbortSignal
      fileTools?: FileTools
      onText: (delta: string) => void
    }>,
  ) => Promise<
    Readonly<{ text: string; history: unknown; sources?: readonly WebSource[] }>
  >
}

export type ExecutionFailure = 'execution-error' | 'interrupted'
export type ExecutionCompletion = {
  sources?: readonly WebSource[] | undefined
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
  ) => Promise<boolean | ExecutionOutcome>
  fail: (
    lease: ExecutionLease,
    reason: ExecutionFailure,
  ) => Promise<boolean | ExecutionOutcome>
  cancel: (lease: ExecutionLease) => Promise<boolean | ExecutionOutcome>
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
  runTimeoutMs?: number
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
  textWrites?: Promise<void> | undefined
  pendingText: string
  pendingBytes: number
  turnTextBytes: number
  historyRejected?: boolean
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
  execution.pendingText = ''
  execution.pendingBytes = 0
  execution.controller.abort()
}

// Fixed local policy: one pending batch (64 KiB), one issued batch (at most
// 64 KiB), and 1 MiB of assistant UTF8 text across all inference/tool iterations.
// These are execution admission limits, not provider token or private-history limits.
const pendingTextLimit = 64 * 1024
const turnTextLimit = 1024 * 1024

type FailureStage =
  | 'renew-sql'
  | 'allocation'
  | 'save-sandbox'
  | 'turn'
  | 'tool'
  | 'append'
  | 'pause'
  | 'terminal-complete'
  | 'terminal-fail'
  | 'terminal-cancel'
  | 'quarantine'
  | 'text-budget'

function diagnose(
  execution: Execution,
  stage: FailureStage,
  classification:
    | 'unknown-outcome'
    | 'text-budget-exceeded'
    | 'history-limit-exceeded' = execution.historyRejected
    ? 'history-limit-exceeded'
    : 'unknown-outcome',
) {
  // Private diagnostics deliberately never inspect a rejected value, including
  // its message/cause/status/body. Public failure reasons remain unchanged.
  console.error({
    runID: execution.lease.runID,
    fence: execution.lease.fence,
    stage,
    classification,
  })
}

async function renew(execution: Execution) {
  const stage: FailureStage = 'renew-sql'
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
  } catch {
    diagnose(execution, stage)
    // Unknown database/native outcome is not permission to keep spending.
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
  // Abort stops spending, not SQL ownership. Keep the lease through bounded
  // harness cleanup, pause and issued writes; only fencing loss ends renewal.
  while (!signal.aborted && execution.reason !== 'lost') {
    await waitForPoll(execution.options.pollMs, signal)
    if (signal.aborted) return
    await renew(execution)
  }
}

function enqueueText(execution: Execution, delta: string) {
  if (
    !execution.acceptingText ||
    execution.reason !== undefined ||
    delta === ''
  )
    return
  const bytes = Buffer.byteLength(delta, 'utf8')
  if (
    bytes > pendingTextLimit - execution.pendingBytes ||
    bytes > turnTextLimit - execution.turnTextBytes
  ) {
    diagnose(execution, 'text-budget', 'text-budget-exceeded')
    // Synchronous admission stops Pi's same owner signal before another inference.
    stop(execution, 'execution-error')
    return
  }
  execution.turnTextBytes += bytes
  execution.pendingBytes += bytes
  execution.pendingText += delta
  // No per-delta promises or closures. The single drain owns every issued append.
  execution.textWrites ??= drainText(execution)
}

async function drainText(execution: Execution) {
  while (execution.pendingText !== '' && execution.reason === undefined) {
    const delta = execution.pendingText
    execution.pendingText = ''
    execution.pendingBytes = 0
    let appended: boolean
    try {
      appended = await execution.deps.writes.appendText(execution.lease, delta)
    } catch {
      diagnose(execution, 'append')
      stop(execution, 'execution-error')
      break
    }
    if (!appended) {
      execution.controller.abort()
      await renew(execution)
      stop(execution, execution.reason ?? 'lost')
    }
  }
  execution.textWrites = undefined
}

async function executeAssignedTurn(execution: Execution): Promise<SettledTurn> {
  let sandbox: SandboxSessionPort | undefined
  let fileTools: FileTools | undefined
  let turnProduct: SettledTurn
  let stage: FailureStage = 'allocation'
  try {
    execution.controller.signal.throwIfAborted()
    sandbox = await execution.deps.openSandbox(
      execution.lease,
      execution.controller.signal,
    )
    stage = 'save-sandbox'
    const saved = await execution.deps.writes.saveSandbox(
      execution.lease,
      sandbox.nativeRef,
    )
    if (!saved) {
      await renew(execution)
      stop(execution, execution.reason ?? 'lost')
      return
    }
    stage = 'tool'
    fileTools = execution.deps.fileTools?.(execution.lease, sandbox, () =>
      stop(execution, 'execution-error'),
    )
    execution.controller.signal.throwIfAborted()
    const tools = sandbox
    execution.acceptingText = true
    stage = 'turn'
    const turn = await execution.deps.harness.turn({
      text: execution.lease.text,
      history: execution.lease.history,
      tools: {
        execute: (request) =>
          executeToolOperation(execution, () => tools.execute(request)),
        read: (request) =>
          executeToolOperation(execution, () => tools.read(request), true),
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
      sources: turn.sources,
      ...(fileTools === undefined ? {} : { assets: fileTools.prepared }),
    }
  } catch (error) {
    execution.historyRejected = error instanceof HistoryLimitError
    // The owner's abort reason is expected interruption. A distinct rejection
    // (including allocation/turn abort cleanup failure) remains an execution error.
    if (
      !execution.controller.signal.aborted ||
      error !== execution.controller.signal.reason
    ) {
      diagnose(execution, stage)
      stop(execution, 'execution-error')
    }
  } finally {
    // The harness owns its bounded abort wait; close and issued writes follow.
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
    if (fileTools?.hasUnknownOutcome()) {
      execution.historyRejected = false
      diagnose(execution, 'tool')
      stop(execution, 'execution-error')
    }
  } catch {
    execution.historyRejected = false
    diagnose(execution, 'pause')
    // A remote TTL is only an orphan backstop, not successful cleanup.
    stop(execution, 'execution-error')
  } finally {
    // Closing the sandbox cannot detach a database write already in flight.
    await execution.textWrites
  }
}

async function finishExecution(
  execution: Execution,
  turnProduct: SettledTurn,
): Promise<ExecutionOutcome> {
  const { lease, deps, reason } = execution
  if (reason === 'lost') return 'lost'
  if (reason === undefined && turnProduct === undefined)
    throw new Error('Execution settled without a turn result')
  let stage: 'terminal-complete' | 'terminal-cancel' | 'terminal-fail' =
    'terminal-complete'
  let accepted: boolean | ExecutionOutcome
  try {
    if (reason === 'cancel') {
      stage = 'terminal-cancel'
      accepted = await deps.writes.cancel(lease)
    } else if (reason !== undefined) {
      stage = 'terminal-fail'
      accepted = await deps.writes.fail(lease, reason)
    } else {
      // An unknown COMMIT must retain uploaded objects, which SQL may have committed.
      accepted = await deps.writes.complete(lease, turnProduct!)
    }
  } catch (error) {
    diagnose(execution, stage)
    throw error
  }
  if (typeof accepted === 'string') return accepted
  if (accepted) {
    const outcomes = {
      'terminal-complete': 'completed',
      'terminal-cancel': 'cancelled',
      'terminal-fail': 'failed',
    } as const
    return outcomes[stage]
  }
  return 'lost'
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
    pendingText: '',
    pendingBytes: 0,
    turnTextBytes: 0,
  }
  const deadline = setTimeout(
    () => stop(execution, 'execution-error'),
    options.runTimeoutMs ?? 120000,
  )
  const shutdown = () => stop(execution, 'interrupted')
  const monitoring = new AbortController()
  options.signal.addEventListener('abort', shutdown, { once: true })
  if (options.signal.aborted) shutdown()
  let polling: Promise<void> | undefined
  try {
    // Authorize before allocation; keep renewal alive through real settlement.
    await renew(execution)
    polling = heartbeat(execution, monitoring.signal)
    const turnProduct = await executeAssignedTurn(execution)
    if (
      turnProduct !== undefined &&
      Buffer.byteLength(turnProduct.text, 'utf8') > turnTextLimit
    ) {
      diagnose(execution, 'text-budget', 'text-budget-exceeded')
      stop(execution, 'execution-error')
    }
    monitoring.abort()
    await polling
    return await finishWithRecovery(execution, turnProduct)
  } finally {
    clearTimeout(deadline)
    monitoring.abort()
    try {
      await polling
    } finally {
      options.signal.removeEventListener('abort', shutdown)
    }
  }
}

async function executeToolOperation<Outcome>(
  execution: Execution,
  operation: () => Promise<Outcome>,
  readOnly = false,
) {
  try {
    execution.controller.signal.throwIfAborted()
    return await operation()
  } catch (error) {
    // Pi normally exposes tool failures to the model. Unknown VM outcomes must
    // instead stop the session, before any automatic next inference.
    if (error !== execution.controller.signal.reason && !readOnly) {
      diagnose(execution, 'tool')
      stop(execution, 'execution-error')
    }
    throw error
  }
}

function requiresSandboxRecovery(reason: StopReason | undefined) {
  return reason === 'lost' || reason === 'execution-error'
}

async function finishWithRecovery(
  execution: Execution,
  turnProduct: SettledTurn,
): Promise<ExecutionOutcome> {
  const { lease } = execution
  if (requiresSandboxRecovery(execution.reason) && !execution.historyRejected) {
    await quarantineExecution(
      execution,
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
    try {
      await quarantineExecution(execution, lease)
    } catch (quarantineError) {
      throw new AggregateError(
        [error, quarantineError],
        'Terminal write and recovery quarantine both failed',
      )
    }
    throw error
  }
  return outcome
}

async function quarantineExecution(
  execution: Execution,
  lease: ExecutionLease,
  reason?: ExecutionFailure,
) {
  try {
    await execution.deps.writes.quarantine(lease, reason)
  } catch (error) {
    diagnose(execution, 'quarantine')
    throw error
  }
}
