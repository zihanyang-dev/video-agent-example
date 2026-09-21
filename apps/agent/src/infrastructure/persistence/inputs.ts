import type { SQL } from 'bun'
import type { MessageInput, StopInput } from '../../domain/run'

// Attachment and sealing share the session lock. A message therefore belongs either
// to an accepting run or to a later run, never to an in-memory timing decision.
export const acceptInput = (sql: SQL, input: MessageInput): Promise<void> =>
  sql.begin(async (transaction) => {
    await transaction`
      insert into execution.sessions (thread_id, entries)
      values (${input.threadID}, ${[]})
      on conflict do nothing
    `
    const [session] = await transaction`
      select active_turn_id
      from execution.sessions
      where thread_id = ${input.threadID}
      for update
    `
    const [active] = await transaction`
      select turn_id
      from execution.runs
      where turn_id = ${session.active_turn_id}
        and accepting
        and state = 'running'
        and lease_until > now()
    `

    const inserted = await transaction`
      insert into execution.inputs (command_id, thread_id, message, turn_id)
      values (${input.commandID}, ${input.threadID}, ${input.message}, ${active?.turn_id ?? null})
      on conflict do nothing
      returning command_id
    `
    if (inserted.length > 0) return

    const [replayed] = await transaction`
      select command_id
      from execution.inputs
      where command_id = ${input.commandID}
        and thread_id = ${input.threadID}
        and message = ${input.message}
    `
    if (!replayed) throw new Error('command ID was already used for different input')
  })

// Bind Stop to its original turn: delayed delivery must not cancel the thread's next run.
export const acceptStop = (sql: SQL, input: StopInput): Promise<void> =>
  sql.begin(async (transaction) => {
    await transaction`
      select thread_id
      from execution.sessions
      where thread_id = ${input.threadID}
      for update
    `

    const inserted = await transaction`
      insert into execution.stops (command_id)
      values (${input.commandID})
      on conflict do nothing
      returning command_id
    `
    if (inserted.length === 0) return

    await transaction`
      update execution.runs
      set cancelled = true, accepting = false
      where turn_id = ${input.turnID} and thread_id = ${input.threadID} and state = 'running'
    `
  })
