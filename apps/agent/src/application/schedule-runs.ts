import type { ExecutionStore } from './ports/execution-store'
import type { Run } from '../domain/run'

// Shutdown stops claiming work, then waits for owned runs. A process killed before
// they finish is recovered through lease expiration, never an automatic prompt replay.
export const scheduleRuns = async (dependencies: {
  store: Pick<ExecutionStore, 'claim' | 'expire'>
  execute: (run: Run) => Promise<void>
  owner: string
  concurrency: number
  pollMs: number
  signal: AbortSignal
}): Promise<void> => {
  const activeRuns = new Set<Promise<void>>()

  const claimNextRun = async (): Promise<void> => {
    if (activeRuns.size >= dependencies.concurrency) return

    const run = await dependencies.store.claim(dependencies.owner)
    if (run === null) return

    const execution = dependencies.execute(run).catch((error: unknown) => {
      console.error(`turn ${run.turnID} could not finish`, error)
    })
    activeRuns.add(execution)
    void execution.then(() => activeRuns.delete(execution))
  }

  try {
    while (!dependencies.signal.aborted) {
      await dependencies.store.expire()
      await claimNextRun()
      await Bun.sleep(dependencies.pollMs)
    }
  } finally {
    await Promise.all(activeRuns)
  }
}
