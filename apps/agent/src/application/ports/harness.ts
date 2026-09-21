import type { Observation } from '../../domain/progress'
import type { Sandbox } from './sandbox'

export type SkillIndex = {
  name: string
  description: string
  dir: string
}

export type ModelChoice = {
  baseUrl: string
  apiKey: string
  id: string
  contextWindow: number
  maxTokens: number
}

export type HarnessInput = {
  sandbox: Sandbox
  model: ModelChoice
  systemPrompt: string
  skills: readonly SkillIndex[]
  /** Opaque outside the harness adapter; product messages cannot reconstruct tool history. */
  history: readonly unknown[] | undefined
  onObservation: (observation: Observation) => void
  turnID: string
}

export type Harness = {
  run: (message: string) => Promise<void>
  steer: (message: string) => Promise<void>
  /** Consumes steering queued as the initial prompt became idle; it may call the model. */
  flush: () => Promise<void>
  /** Aborts active work and clears queued steering before the caller takes a checkpoint. */
  interrupt: () => Promise<void>
  entries: () => readonly unknown[]
  dispose: () => void
}

export type StartHarness = (input: HarnessInput) => Promise<Harness>
