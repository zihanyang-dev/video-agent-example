import type { Run } from '../domain/run'
import type { ExecutionStore } from './ports/execution-store'
import type { Harness } from './ports/harness'

export const controlRun = async (dependencies: {
  store: Pick<ExecutionStore, 'controls' | 'delivered'>
  run: Run
  harness: Harness
  signal: AbortSignal
  pollMs: number
}): Promise<void> => {
  while (!dependencies.signal.aborted) {
    const controls = await dependencies.store.controls(dependencies.run)
    if (dependencies.signal.aborted) return
    if (controls.cancelled) {
      await dependencies.harness.interrupt()
      return
    }

    for (const input of controls.messages) {
      // Mark intent first: a crash after steer() must not replay uncertain model work.
      // A crash between these calls can leave this input unconsumed by the model.
      await dependencies.store.delivered(input.commandID)
      await dependencies.harness.steer(input.message)
    }

    await Bun.sleep(dependencies.pollMs)
  }
}

export const keepLease = async (dependencies: {
  store: Pick<ExecutionStore, 'renew'>
  run: Run
  signal: AbortSignal
  pollMs: number
}): Promise<void> => {
  while (!dependencies.signal.aborted) {
    if (!(await dependencies.store.renew(dependencies.run)))
      throw new Error(`execution lease lost for ${dependencies.run.turnID}`)

    await Bun.sleep(dependencies.pollMs)
  }
}
