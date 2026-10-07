import { HistoryLimitError } from '../harness/pi-history'
import { waitForPoll } from './wait-for-poll'
import type {
  ExecutionLease,
  ExecutionCompletion,
  ExecutionFailure,
  ExecutionOutcome,
  ExecuteRunDependencies,
  ExecuteRunOptions,
  SandboxSessionPort,
  FileTools,
} from './contract'

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

function preferredStopReason(current: StopReason | undefined, requested: StopReason): StopReason {
  if (current === 'lost') return current
  if (current === undefined || requested === 'lost' || requested === 'execution-error')
    return requested
  if (requested === 'cancel' && current === 'interrupted') return requested
  return current
}

function stop(execution: Execution, reason: StopReason) {
  // Fencing loss dominates: this worker must never attempt a stale terminal mutation.
  if (execution.reason === 'lost') return
  execution.reason = preferredStopReason(execution.reason, reason)
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

type FailureClassification = 'unknown-outcome' | 'text-budget-exceeded' | 'history-limit-exceeded'

function diagnose(
  execution: Execution,
  stage: FailureStage,
  classification?: FailureClassification,
) {
  classification ??= execution.historyRejected ? 'history-limit-exceeded' : 'unknown-outcome'
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
    const status = await execution.deps.writes.renew(execution.lease, execution.options.leaseMs)
    if (status !== 'renewed')
      stop(execution, status === 'recovery-required' ? 'execution-error' : status)
  } catch {
    diagnose(execution, stage)
    // Unknown database/native outcome is not permission to keep spending.
    stop(execution, 'execution-error')
  }
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
  if (!execution.acceptingText || execution.reason !== undefined || delta === '') return
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
    sandbox = await execution.deps.openSandbox(execution.lease, execution.controller.signal)
    stage = 'save-sandbox'
    const saved = await execution.deps.writes.saveSandbox(execution.lease, sandbox.nativeRef)
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
        execute: (request) => executeToolOperation(execution, () => tools.execute(request)),
        read: (request) => executeToolOperation(execution, () => tools.read(request), 'read-only'),
        write: (request) => executeToolOperation(execution, () => tools.write(request)),
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
    if (!execution.controller.signal.aborted || error !== execution.controller.signal.reason) {
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
  if (reason === undefined) return await completeExecution(execution, turnProduct)
  const stage = reason === 'cancel' ? 'terminal-cancel' : 'terminal-fail'
  try {
    if (reason === 'cancel') return await deps.writes.cancel(lease)
    return await deps.writes.fail(lease, reason)
  } catch (error) {
    diagnose(execution, stage)
    throw error
  }
}

async function completeExecution(
  execution: Execution,
  turnProduct: SettledTurn,
): Promise<ExecutionOutcome> {
  if (turnProduct === undefined) throw new Error('Execution settled without a turn result')
  try {
    // An unknown COMMIT must retain uploaded objects, which SQL may have committed.
    return await execution.deps.writes.complete(execution.lease, turnProduct)
  } catch (error) {
    diagnose(execution, 'terminal-complete')
    throw error
  }
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
    if (turnProduct !== undefined && Buffer.byteLength(turnProduct.text, 'utf8') > turnTextLimit) {
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
  kind: 'read-only' | 'mutative' = 'mutative',
) {
  try {
    execution.controller.signal.throwIfAborted()
    return await operation()
  } catch (error) {
    // Pi normally exposes tool failures to the model. Unknown VM outcomes must
    // instead stop the session, before any automatic next inference.
    if (error !== execution.controller.signal.reason && kind === 'mutative') {
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
  if (requiresSandboxRecovery(execution.reason) && !execution.historyRejected) {
    await quarantineExecution(
      execution,
      execution.reason === 'execution-error' ? 'execution-error' : 'interrupted',
    )
    return execution.reason === 'lost' ? 'lost' : 'failed'
  }
  let outcome: ExecutionOutcome
  try {
    outcome = await finishExecution(execution, turnProduct)
  } catch (error) {
    // A lost COMMIT acknowledgement is not permission to reuse the VM.
    try {
      await quarantineExecution(execution)
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

async function quarantineExecution(execution: Execution, reason?: ExecutionFailure) {
  try {
    await execution.deps.writes.quarantine(execution.lease, reason)
  } catch (error) {
    diagnose(execution, 'quarantine')
    throw error
  }
}
