import type { Progress, Outcome } from '../../domain/progress'
import type { Checkpoint, Controls, MessageInput, Run, StopInput } from '../../domain/run'

/**
 * Mutating a claimed run requires current ownership. Implementations must enforce that
 * inside the write transaction; a heartbeat checked earlier is not authorization.
 */
export type ExecutionStore = {
  accept: (input: MessageInput) => Promise<void>
  stop: (input: StopInput) => Promise<void>
  claim: (owner: string) => Promise<Run | null>
  renew: (run: Run) => Promise<boolean>
  controls: (run: Run) => Promise<Controls>
  /** Records delivery intent, not proof that the model consumed the input. */
  delivered: (commandID: string) => Promise<void>
  /** Stops attachment to this run and releases untouched inputs for a later run. */
  seal: (run: Run) => Promise<void>
  checkpoint: (threadID: string) => Promise<Checkpoint>
  append: (run: Run, progress: Progress) => Promise<void>
  /** Commits the checkpoint and terminal event atomically, while releasing the thread. */
  complete: (
    run: Run,
    completion: { checkpoint: Checkpoint; outcome: Outcome; reason: string | null },
  ) => Promise<void>
  expire: () => Promise<void>
}
