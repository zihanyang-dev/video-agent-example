import { executeRun } from './execute-run'
import { waitForPoll } from './wait-for-poll'
import type { ExecuteRunDependencies, ExecuteRunOptions, ExecutionLease } from './contract'

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
  runTimeoutMs?: number
  signal: AbortSignal
}>

/** The process owns claims and every active run; shutdown never detaches cleanup. */
export async function runWorker(deps: WorkerDependencies, options: WorkerOptions): Promise<void> {
  const stop = new AbortController()
  const signal = AbortSignal.any([options.signal, stop.signal])
  const active = new Map<string, Promise<void>>()
  const failures: unknown[] = []

  async function superviseRun(lease: ExecutionLease) {
    try {
      const runOptions: ExecuteRunOptions = {
        leaseMs: options.leaseMs,
        pollMs: options.pollMs,
        signal,
        ...(options.runTimeoutMs === undefined ? {} : { runTimeoutMs: options.runTimeoutMs }),
      }
      await executeRun(lease, deps, runOptions)
    } catch (error) {
      failures.push(error)
      stop.abort()
    } finally {
      active.delete(lease.runID)
    }
  }

  async function schedule() {
    while (!signal.aborted) {
      if (active.size >= options.concurrency) {
        await waitForPoll(options.pollMs, signal)
        continue
      }
      let lease: ExecutionLease | null
      try {
        lease = await deps.claim({
          ownerID: options.ownerID,
          leaseMs: options.leaseMs,
        })
      } catch (error) {
        failures.push(error)
        break
      }
      if (lease === null) {
        await waitForPoll(options.pollMs, signal)
        continue
      }
      // A claim can finish after shutdown. Supervision still settles that
      // capability as interrupted without starting new inference.
      active.set(lease.runID, superviseRun(lease))
    }
  }

  try {
    await schedule()
  } catch (error) {
    failures.push(error)
  }
  stop.abort()
  await Promise.all(active.values())
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) {
    throw new AggregateError(failures, 'Worker execution failed')
  }
}
