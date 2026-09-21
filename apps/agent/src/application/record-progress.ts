import type { Observation } from '../domain/progress'
import type { Run } from '../domain/run'
import type { ExecutionStore } from './ports/execution-store'
import type { Sandbox } from './ports/sandbox'
import type { Workspace } from './ports/workspace'

/**
 * Harness callbacks cannot await persistence. Serialize observations so a slow artifact
 * upload cannot be overtaken by later progress; retain the first failure for drain()
 * while allowing subsequent observations to settle.
 */
export const createProgressRecorder = (dependencies: {
  store: Pick<ExecutionStore, 'append'>
  workspace: Workspace
  run: Run
  sandbox: Sandbox
}) => {
  let pending = Promise.resolve()
  let failure: unknown = null

  const publish = async (observation: Observation): Promise<void> => {
    if (observation.kind !== 'artifact')
      return dependencies.store.append(dependencies.run, observation)

    const key = await dependencies.workspace.publish(
      dependencies.sandbox,
      observation,
      dependencies.run.turnID,
    )
    await dependencies.store.append(dependencies.run, {
      kind: 'artifact',
      messageID: observation.messageID,
      key,
      role: observation.role,
    })
  }

  return {
    observe: (observation: Observation): void => {
      pending = pending
        .then(() => publish(observation))
        .catch((error: unknown) => {
          failure ??= error
        })
    },

    drain: async (): Promise<void> => {
      await pending
      if (failure !== null) throw failure
    },
  }
}
