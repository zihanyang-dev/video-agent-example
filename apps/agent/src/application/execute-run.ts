import type { Run, Checkpoint } from '../domain/run'
import type { Harness } from './ports/harness'
import type { ExecutionDependencies } from './ports/execution'
import type { Sandbox } from './ports/sandbox'
import { createProgressRecorder } from './record-progress'
import { keepLease } from './control-run'
import { completeExecution } from './complete-execution'

type Attempt = {
  dependencies: ExecutionDependencies
  run: Run
  checkpoint: Checkpoint
  sandbox: Sandbox | null
  harness: Harness | null
  signal: AbortSignal
}

/**
 * The lease covers preparation as well as model work. Losing it must prevent a new
 * prompt, even when no harness existed yet to interrupt. Teardown waits for renewal
 * to stop before disposing the harness it may still be using.
 */
export const createExecuteRun =
  (dependencies: ExecutionDependencies) =>
  async (run: Run): Promise<void> => {
    const stopLease = new AbortController()
    const ownershipLost = new AbortController()
    const attempt: Attempt = {
      dependencies,
      run,
      checkpoint: await dependencies.store.checkpoint(run.threadID),
      sandbox: null,
      harness: null,
      signal: ownershipLost.signal,
    }

    const lease = keepLease({
      store: dependencies.store,
      run,
      signal: stopLease.signal,
      pollMs: dependencies.pollMs,
    }).catch(async (error: unknown) => {
      ownershipLost.abort(error)
      try {
        await attempt.harness?.interrupt()
      } catch (interruption) {
        console.error(`turn ${run.turnID}: interruption failed`, interruption)
      }
      return error
    })

    try {
      await executeAttempt(attempt)
    } finally {
      stopLease.abort()
      const leaseFailure = await lease
      if (leaseFailure !== undefined) {
        console.error(`turn ${run.turnID}: lease renewal failed`, leaseFailure)
      }

      await releaseAttempt(attempt)
    }
  }

// Preparation failures retain the previous checkpoint. This fallback is still fenced
// by complete(): an expired worker cannot turn its own failure into a committed result.
const executeAttempt = async (attempt: Attempt): Promise<void> => {
  try {
    await prepareAndComplete(attempt)
  } catch (error) {
    await attempt.dependencies.store.complete(attempt.run, {
      checkpoint: attempt.checkpoint,
      outcome: 'failed',
      reason: error instanceof Error ? error.message : String(error),
    })
  }
}

const prepareAndComplete = async (attempt: Attempt): Promise<void> => {
  const { dependencies, run, checkpoint } = attempt
  if ((await dependencies.store.controls(run)).cancelled) {
    await dependencies.store.complete(run, { checkpoint, outcome: 'cancelled', reason: null })
    return
  }

  attempt.signal.throwIfAborted()
  const sandbox = await dependencies.rentSandbox({
    image: dependencies.sandboxImage,
    network: dependencies.sandboxNetwork,
    env: await dependencies.sandboxEnv(run),
  })
  attempt.sandbox = sandbox

  await dependencies.workspace.restore(sandbox, checkpoint.workspace)
  await dependencies.workspace.skills(sandbox)

  const recorder = createProgressRecorder({
    store: dependencies.store,
    workspace: dependencies.workspace,
    run,
    sandbox,
  })

  attempt.signal.throwIfAborted()
  const harness = await dependencies.startHarness({
    sandbox,
    model: dependencies.model,
    systemPrompt: dependencies.systemPrompt,
    skills: dependencies.skills,
    history: checkpoint.entries,
    onObservation: recorder.observe,
    turnID: run.turnID,
  })
  attempt.harness = harness

  await completeExecution({
    dependencies,
    run,
    checkpoint,
    sandbox,
    harness,
    recorder,
    signal: attempt.signal,
  })
}

const releaseAttempt = async (attempt: Attempt): Promise<void> => {
  try {
    attempt.harness?.dispose()
  } catch (error) {
    console.error(`turn ${attempt.run.turnID}: harness disposal failed`, error)
  }

  try {
    await attempt.sandbox?.destroy()
  } catch (error) {
    // Cleanup cannot change a committed result or replace the execution failure.
    console.error(`turn ${attempt.run.turnID}: sandbox disposal failed`, error)
  }
}
