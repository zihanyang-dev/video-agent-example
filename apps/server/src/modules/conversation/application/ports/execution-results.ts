import type { ExecutionResult } from '../../domain/execution-result'

export type ExecutionResults = {
  /** True includes an already committed event; false defers a sequence gap. */
  apply: (result: ExecutionResult) => Promise<boolean>
}
