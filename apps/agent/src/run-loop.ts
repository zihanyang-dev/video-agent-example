import {
  executeRun,
  type ExecuteRunDependencies,
  type ExecutionLease,
} from './execute-run'

type WorkerDependencies = ExecuteRunDependencies &
  Readonly<{
    claim: (
      options: Readonly<{ ownerID: string; leaseMs: number }>,
    ) => Promise<ExecutionLease | null>
  }>
type WorkerOptions = Readonly<{
  ownerID: string
  concurrency: number
  leaseMs: number
  pollMs: number
  signal: AbortSignal
}>

type Worker = Readonly<{
  deps: WorkerDependencies
  options: WorkerOptions
  stop: AbortController
  signal: AbortSignal
  active: Map<string, Promise<void>>
  failures: unknown[]
}>

/** The process owns claims and every active run; shutdown never detaches cleanup. */
export async function runWorker(
  deps: WorkerDependencies,
  options: WorkerOptions,
): Promise<void> {
  const stop = new AbortController()
  const worker: Worker = {
    deps,
    options,
    stop,
    signal: AbortSignal.any([options.signal, stop.signal]),
    active: new Map(),
    failures: [],
  }
  try {
    while (!worker.signal.aborted) {
      await claimAvailable(worker)
      await waitForPoll(options.pollMs, worker.signal)
    }
  } catch (error) {
    worker.failures.push(error)
  } finally {
    stop.abort()
    await Promise.all(worker.active.values())
  }
  if (worker.failures.length === 1) throw worker.failures[0]
  if (worker.failures.length > 1) {
    throw new AggregateError(worker.failures, 'Worker execution failed')
  }
}

async function claimAvailable(worker: Worker) {
  const { deps, options, active, signal } = worker
  while (active.size < options.concurrency && !signal.aborted) {
    const lease = await deps.claim({
      ownerID: options.ownerID,
      leaseMs: options.leaseMs,
    })
    if (lease === null) return
    // A claim can finish after shutdown. Supervision still settles that
    // capability as interrupted without starting new inference.
    active.set(lease.runID, supervise(worker, lease))
  }
}

async function supervise(worker: Worker, lease: ExecutionLease) {
  const { deps, options, signal } = worker
  try {
    await executeRun(lease, deps, {
      leaseMs: options.leaseMs,
      pollMs: options.pollMs,
      signal,
    })
  } catch (error) {
    worker.failures.push(error)
    worker.stop.abort()
  } finally {
    worker.active.delete(lease.runID)
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
