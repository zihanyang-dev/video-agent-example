import {
  type ExecutionLease,
  type ExecutionCompletion,
  type ExecutionFailure,
  type ExecutionOutcome,
  type ExecuteRunDependencies,
  type ExecuteRunOptions,
  type SandboxSessionPort,
  type SandboxFiles,
  type SandboxTools,
  type FileTools,
} from '../contract.ts'
import { waitForPoll } from './wait-for-poll'
import { CapabilityRejectedError, NativeOwnerUnsettledError } from '../contract'

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
  uncertain: boolean
  pendingEffects: number
  failures: unknown[]
  nativeUnsettled?: NativeOwnerUnsettledError
  cleanupFailed: boolean
}

function preferredStopReason(current: StopReason | undefined, requested: StopReason): StopReason {
  if (current === 'lost' || requested === 'lost') return 'lost'
  if (current === 'cancel' || requested === 'cancel') return 'cancel'
  if (current === undefined || requested === 'execution-error') return requested
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

type FailureClassification = 'unknown-outcome' | 'text-budget-exceeded'

function diagnose(
  execution: Execution,
  stage: FailureStage,
  classification?: FailureClassification,
) {
  classification ??= 'unknown-outcome'
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
  if (
    execution.lease.restoring ||
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
    // Synchronous admission stops the harness owner before another inference.
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
      await rejectedAuthority(execution)
    }
  }
  execution.textWrites = undefined
}

async function rejectedAuthority(execution: Execution) {
  await renew(execution)
  stop(execution, execution.reason ?? 'lost')
}

type Allocation = { issued: boolean; transition: boolean }

async function allocateWorkspace(execution: Execution, allocation: Allocation) {
  execution.controller.signal.throwIfAborted()
  allocation.transition = await execution.deps.writes.beginWorkspaceTransition(execution.lease)
  if (!allocation.transition) {
    await rejectedAuthority(execution)
    return undefined
  }
  execution.controller.signal.throwIfAborted()
  const { runID, threadID, fence, nativeRef, restoreWorkspace } = execution.lease
  allocation.issued = true
  return await execution.deps.openSandbox(
    { runID, threadID, fence, nativeRef, restoring: restoreWorkspace },
    execution.controller.signal,
  )
}

async function settleUnissuedAllocation(execution: Execution, allocation: Allocation) {
  if (allocation.transition && !allocation.issued)
    await execution.deps.writes.settleWorkspaceTransition(execution.lease)
}

async function executeAssignedTurn(execution: Execution): Promise<SettledTurn> {
  let sandbox: SandboxSessionPort | undefined
  let fileTools: FileTools | undefined
  let turnProduct: SettledTurn
  let stage: FailureStage = 'allocation'
  const allocation = { issued: false, transition: false }
  try {
    sandbox = await allocateWorkspace(execution, allocation)
    if (sandbox === undefined) return
    const { runID, threadID } = execution.lease
    stage = 'save-sandbox'
    const saved = await execution.deps.writes.saveSandbox(execution.lease, sandbox.nativeRef)
    if (!saved) {
      await rejectedAuthority(execution)
      return
    }
    stage = 'tool'
    const { guardedSandbox, fileTools: assignedTools } = guardCapabilities(execution, sandbox)
    fileTools = assignedTools
    execution.controller.signal.throwIfAborted()
    execution.acceptingText = true
    stage = 'turn'
    const turn = await execution.deps.harness.run({
      engine: execution.lease.engine,
      threadID,
      nativeSessionID: execution.lease.nativeSessionID,
      nativeSessionStorage: execution.lease.nativeSessionStorage,
      initialContext: execution.lease.initialContext,
      requireExisting: execution.lease.requireExisting === true,
      runID,
      text: execution.lease.text,
      tools: guardedSandbox,
      beforeModel: () => authorizeModel(execution),
      checkpoint: async () => {
        execution.controller.signal.throwIfAborted()
        if (!(await execution.deps.writes.checkpoint(execution.lease))) {
          await rejectedAuthority(execution)
          execution.controller.signal.throwIfAborted()
        }
        execution.pendingEffects = 0
      },
      signal: execution.controller.signal,
      ...(fileTools === undefined ? {} : { fileTools }),
      onText: (delta) => enqueueText(execution, delta),
    })
    execution.acceptingText = false
    execution.controller.signal.throwIfAborted()
    turnProduct = completionProduct(turn, fileTools)
  } catch (error) {
    notifyNativeUnsettled(execution, error)
    if (stage === 'allocation') execution.uncertain ||= allocation.issued
    // The owner's abort reason is expected interruption. A distinct rejection
    // (including allocation/turn abort cleanup failure) remains an execution error.
    if (!execution.controller.signal.aborted || error !== execution.controller.signal.reason) {
      execution.failures.push(error)
      diagnose(execution, stage)
      stop(execution, 'execution-error')
    }
  } finally {
    // The harness owns its bounded abort wait; close and issued writes follow.
    execution.acceptingText = false
    await settleUnissuedAllocation(execution, allocation)
    await settleResources(execution, sandbox)
  }
  // Cleanup and queued writes can stop an otherwise successful turn. The stop
  // reason retains terminal authority; only a settled success carries products.
  return execution.reason === undefined ? turnProduct : undefined
}

function notifyNativeUnsettled(execution: Execution, error: unknown) {
  if (!(error instanceof NativeOwnerUnsettledError)) return
  execution.nativeUnsettled = error
  // A local SDK writer is not an unknown guest effect. Fail-stop the shared
  // worker synchronously before cleanup or SQL can release ownership.
  stop(execution, 'execution-error')
  try {
    execution.deps.onNativeUnsettled?.(error)
  } catch (notificationError) {
    execution.failures.push(notificationError)
  }
}

function assertNativeSettled(execution: Execution) {
  if (execution.nativeUnsettled === undefined) return
  if (execution.failures.length > 1)
    throw new AggregateError(execution.failures, 'Native owner and execution cleanup failed')
  throw execution.nativeUnsettled
}

function completionProduct(
  turn: ExecutionCompletion,
  fileTools: FileTools | undefined,
): ExecutionCompletion {
  if (turn.assets !== undefined || fileTools === undefined) return turn
  return { ...turn, assets: fileTools.prepared }
}

function guardCapabilities(execution: Execution, sandbox: SandboxSessionPort) {
  const { runID, threadID, fence, assets } = execution.lease
  const guardedSandbox: SandboxTools & SandboxFiles = {
    execute: (request) => executeToolOperation(execution, () => sandbox.execute(request)),
    read: (request) => executeToolOperation(execution, () => sandbox.read(request), 'read-only'),
    write: (request) => executeToolOperation(execution, () => sandbox.write(request)),
    readBytes: (...args) =>
      executeToolOperation(execution, () => sandbox.readBytes(...args), 'read-only'),
    writeBytes: (...args) => executeToolOperation(execution, () => sandbox.writeBytes(...args)),
  }
  const assignedFiles = execution.deps.fileTools?.(
    { runID, threadID, fence, assets },
    guardedSandbox,
    () => {
      // Only invoked IO failures report uncertainty; local admission failures
      // retain their operation-specific no-dispatch correction instead.
      if (execution.reason === undefined) execution.uncertain = true
      stop(execution, 'execution-error')
    },
    () => reserveEffect(execution),
  )
  const fileTools: FileTools | undefined =
    assignedFiles === undefined
      ? undefined
      : {
          get assigned() {
            return assignedFiles.assigned
          },
          get prepared() {
            return assignedFiles.prepared
          },
          importFile: (request) =>
            executeToolOperation(execution, () => assignedFiles.importFile(request), 'read-only'),
          exportFile: (request) =>
            executeToolOperation(execution, () => assignedFiles.exportFile(request), 'read-only'),
        }
  return { guardedSandbox, fileTools }
}

async function closeWorkspace(execution: Execution, sandbox: SandboxSessionPort) {
  try {
    await execution.deps.writes.beginWorkspaceTransition(execution.lease)
  } catch (error) {
    execution.failures.push(error)
    stop(execution, 'execution-error')
  }
  await sandbox.close()
  await execution.deps.writes.settleWorkspaceTransition(execution.lease)
}

async function settleResources(execution: Execution, sandbox: SandboxSessionPort | undefined) {
  try {
    if (sandbox !== undefined) await closeWorkspace(execution, sandbox)
  } catch (error) {
    execution.cleanupFailed = true
    execution.failures.push(error)
    execution.uncertain = true
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
    uncertain: false,
    pendingEffects: 0,
    failures: [],
    cleanupFailed: false,
  }
  const remainingMs = Math.min(
    lease.deadlineAt.getTime() - Date.now(),
    options.runTimeoutMs ?? Infinity,
  )
  if (remainingMs <= 0) stop(execution, 'execution-error')
  const deadline = setTimeout(() => stop(execution, 'execution-error'), Math.max(0, remainingMs))
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
    // SQL may durably cancel/fail after guest settlement. Even then the Native
    // owner is NOT reusable: the worker keeps its kernel lock until physical exit.
    // Unknown terminal COMMIT remains the primary error (never retry); the fatal
    // cause was already retained by the synchronous worker notification.
    const outcome = await finishWithRecovery(execution, turnProduct)
    assertNativeSettled(execution)
    return outcome
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
  // The receipt proves ownership of exactly this operation's reservation.
  let releaseUnissued: (() => Promise<void>) | undefined
  try {
    execution.controller.signal.throwIfAborted()
    await renew(execution)
    execution.controller.signal.throwIfAborted()
    if (kind === 'mutative') releaseUnissued = await reserveEffect(execution)
  } catch (error) {
    throw new CapabilityRejectedError('Tool dispatch was refused before IO', { cause: error })
  }
  // Awaiting admission itself yields: recheck at the actual dispatch boundary.
  try {
    execution.controller.signal.throwIfAborted()
  } catch (error) {
    await rejectUnissued(releaseUnissued, error)
  }
  try {
    return await operation()
  } catch (error) {
    if (kind === 'mutative' && error instanceof CapabilityRejectedError) {
      await rejectUnissued(releaseUnissued, error)
    } else if (kind === 'mutative') {
      execution.uncertain = true
      execution.failures.push(error)
      diagnose(execution, 'tool')
      stop(execution, 'execution-error')
    }
    throw error
  }
}

async function rejectUnissued(release: (() => Promise<void>) | undefined, error: unknown) {
  try {
    await release?.()
  } catch (correctionError) {
    throw new AggregateError([error, correctionError], 'Unissued effect correction failed')
  }
  throw error
}

/** A local receipt is created only after SQL confirms this reservation. No
 * receipt exists for an unknown ACK, and it is usable only with no-dispatch proof. */
async function reserveEffect(execution: Execution): Promise<() => Promise<void>> {
  execution.controller.signal.throwIfAborted()
  let decision
  try {
    decision = await execution.deps.writes.beginEffect(execution.lease)
  } catch (error) {
    execution.uncertain = true
    execution.failures.push(error)
    stop(execution, 'execution-error')
    throw error
  }
  if (decision !== 'allowed') {
    stop(execution, decision === 'cancel' || decision === 'lost' ? decision : 'execution-error')
    execution.controller.signal.throwIfAborted()
  }
  // Track the confirmed ACK before observing a concurrent owner abort.
  execution.pendingEffects++
  let released = false
  const releaseUnissued = async () => {
    if (released) return
    released = true
    try {
      if (!(await execution.deps.writes.rejectEffect(execution.lease)))
        throw new Error('Unissued effect correction was not acknowledged')
      execution.pendingEffects--
    } catch (error) {
      execution.uncertain = true
      execution.failures.push(error)
      stop(execution, 'execution-error')
      throw error
    }
  }
  try {
    execution.controller.signal.throwIfAborted()
  } catch (error) {
    await rejectUnissued(releaseUnissued, error)
  }
  return releaseUnissued
}

async function authorizeModel(execution: Execution) {
  execution.controller.signal.throwIfAborted()
  let decision
  try {
    decision = await execution.deps.writes.reserveModel(execution.lease)
  } catch (error) {
    stop(execution, 'execution-error')
    throw error
  }
  if (decision !== 'allowed')
    stop(execution, decision === 'cancel' || decision === 'lost' ? decision : 'execution-error')
  execution.controller.signal.throwIfAborted()
}

function recoveryReason(reason: StopReason | undefined): ExecutionFailure | undefined {
  if (reason === 'cancel' || reason === 'lost') return undefined
  return reason ?? 'execution-error'
}

async function finishWithRecovery(
  execution: Execution,
  turnProduct: SettledTurn,
): Promise<ExecutionOutcome> {
  if (execution.uncertain || (execution.reason !== undefined && execution.pendingEffects > 0)) {
    try {
      await quarantineExecution(execution, recoveryReason(execution.reason))
    } catch (error) {
      throw new AggregateError(
        [...execution.failures, error],
        'Execution and recovery settlement failed',
      )
    }
    if (execution.reason === undefined) stop(execution, 'execution-error')
    const outcome = await finishExecution(execution, undefined)
    if (execution.cleanupFailed && execution.failures.length > 1)
      throw new AggregateError(execution.failures, 'Execution and remote cleanup failed')
    return outcome
  }
  return await finishExecution(execution, turnProduct)
}

async function quarantineExecution(execution: Execution, reason?: ExecutionFailure) {
  try {
    await execution.deps.writes.quarantine(execution.lease, reason)
  } catch (error) {
    diagnose(execution, 'quarantine')
    throw error
  }
}
