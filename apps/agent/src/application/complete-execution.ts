import { completionOutcome, type Run, type Checkpoint } from '../domain/run'
import type { Harness } from './ports/harness'
import type { Sandbox } from './ports/sandbox'
import type { ExecutionDependencies } from './ports/execution'
import type { createProgressRecorder } from './record-progress'
import { controlRun } from './control-run'

type Execution = {
  dependencies: ExecutionDependencies
  run: Run
  checkpoint: Checkpoint
  sandbox: Sandbox
  harness: Harness
  signal: AbortSignal
  recorder: ReturnType<typeof createProgressRecorder>
}

/**
 * Model completion is not durable completion. Drain observations and save files before
 * committing history, the workspace reference and the terminal event together. Failed
 * prompts still need their files saved: they may contain a paid provider's job ID.
 */
export const completeExecution = async (execution: Execution): Promise<void> => {
  const { dependencies, run, harness, sandbox, recorder } = execution
  const executionFailure = await executePrompts(execution)

  let persistenceFailure: unknown = null
  let checkpoint = execution.checkpoint
  try {
    await recorder.drain()
  } catch (error) {
    persistenceFailure ??= error
  }

  try {
    checkpoint = {
      entries: harness.entries(),
      workspace: await dependencies.workspace.save(sandbox, run.turnID),
    }
  } catch (error) {
    persistenceFailure ??= error
  }

  const cancelled = (await dependencies.store.controls(run)).cancelled
  const failure = persistenceFailure ?? (cancelled ? null : executionFailure)
  const outcome = completionOutcome({
    cancelled,
    executionFailed: executionFailure !== null,
    persistenceFailed: persistenceFailure !== null,
  })
  const reason =
    failure === null ? null : failure instanceof Error ? failure.message : JSON.stringify(failure)

  await dependencies.store.complete(run, { checkpoint, outcome, reason })
}

// Await the steering loop before sealing; otherwise it could deliver an input already
// reassigned to the next run. Queued harness work is then flushed with Stop still active.
const executePrompts = async (execution: Execution): Promise<unknown> => {
  const { dependencies, run, harness } = execution
  const failure = await promptWithControls(execution, () => harness.run(run.message))
  await dependencies.store.seal(run)
  if (failure !== null) return failure

  return promptWithControls(execution, harness.flush)
}

const promptWithControls = async (
  execution: Execution,
  prompt: () => Promise<void>,
): Promise<unknown> => {
  const { dependencies, run, harness } = execution
  if ((await dependencies.store.controls(run)).cancelled) return null

  execution.signal.throwIfAborted()
  const stopControls = new AbortController()
  const controls = controlRun({
    store: dependencies.store,
    run,
    harness,
    signal: AbortSignal.any([stopControls.signal, execution.signal]),
    pollMs: dependencies.pollMs,
  }).catch(async (error: unknown) => {
    await harness.interrupt()
    return error
  })

  let failure: unknown = null
  try {
    await prompt()
  } catch (error) {
    failure = error
  } finally {
    stopControls.abort()
  }

  const controlFailure = await controls
  return failure ?? controlFailure ?? null
}
