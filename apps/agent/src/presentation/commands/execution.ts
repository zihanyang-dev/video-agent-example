import { ExecutionCommand } from '@vid/contract/execution'
import type { ExecutionStore } from '../../application/ports/execution-store'

export const receiveCommand =
  (store: Pick<ExecutionStore, 'accept' | 'stop'>) =>
  async (body: unknown): Promise<boolean> => {
    const command = ExecutionCommand.parse(body)
    if (command.kind === 'message') await store.accept(command)
    else await store.stop(command)
    return true
  }
