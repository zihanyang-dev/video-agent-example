import type { Run } from '../../domain/run'
import type { ExecutionStore } from './execution-store'
import type { ModelChoice, SkillIndex, StartHarness } from './harness'
import type { RentSandbox } from './sandbox'
import type { Workspace } from './workspace'

export type ExecutionDependencies = {
  store: Pick<
    ExecutionStore,
    'renew' | 'controls' | 'delivered' | 'seal' | 'checkpoint' | 'append' | 'complete'
  >
  workspace: Workspace
  startHarness: StartHarness
  rentSandbox: RentSandbox
  model: ModelChoice
  skills: readonly SkillIndex[]
  systemPrompt: string
  sandboxImage: string
  sandboxNetwork: string
  pollMs: number
  sandboxEnv: (run: Run) => Promise<Record<string, string>>
}
