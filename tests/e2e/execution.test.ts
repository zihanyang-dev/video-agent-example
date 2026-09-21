import { afterAll, beforeAll, expect, test } from 'bun:test'
import { createTestDatabase } from '../fixtures/database'
import { createPostgresConversations } from '../../apps/server/src/modules/conversation/infrastructure/persistence/conversations'
import { createPostgresExecutionResults } from '../../apps/server/src/modules/conversation/infrastructure/persistence/execution-results'
import { createPostgresExecutionStore } from '../../apps/agent/src/infrastructure/persistence/execution-store'
import { receiveExecution } from '../../apps/server/src/modules/conversation/presentation/events/execution'
import { receiveCommand } from '../../apps/agent/src/presentation/commands/execution'
import { publishCommands } from '../../apps/server/src/modules/conversation/infrastructure/execution/commands'
import { publishEvents } from '../../apps/agent/src/infrastructure/messaging/events'
import type { Mailbox } from '../../packages/queue/src/redis-mailbox'
import type { Run } from '../../apps/agent/src/domain/run'

let database: Awaited<ReturnType<typeof createTestDatabase>>

beforeAll(async () => {
  database = await createTestDatabase()
})

afterAll(async () => {
  await database.close()
})

const fixture = async () => {
  const conversations = createPostgresConversations(database.product)
  const executions = createPostgresExecutionStore(database.execution, 30000)
  const threadID = crypto.randomUUID()

  await conversations.open({ threadID, userID: 'owner' })
  const input = { commandID: crypto.randomUUID(), threadID, message: 'Make a video' }

  return { conversations, executions, threadID, input }
}

const mailbox = (accept: (body: unknown) => Promise<boolean>): Mailbox => ({
  publish: async (body) => {
    await accept(body)
  },
  consume: async () => {},
  close: () => {},
})

const complete = async (executions: ReturnType<typeof createPostgresExecutionStore>, run: Run) => {
  await executions.seal(run)
  await executions.complete(run, {
    checkpoint: { entries: ['saved'], workspace: 'immutable/' },
    outcome: 'succeeded',
    reason: null,
  })
}

test('commands and results cross ownership boundaries without sharing tables', async () => {
  const { conversations, executions, threadID, input } = await fixture()
  await conversations.accept(input)
  await publishCommands(database.product, mailbox(receiveCommand(executions)))
  const run = (await executions.claim('worker'))!
  expect(run.threadID).toBe(threadID)
  await executions.append(run, { kind: 'text-start', messageID: 'answer', channel: 'assistant' })
  await executions.append(run, {
    kind: 'text-delta',
    messageID: 'answer',
    channel: 'assistant',
    delta: 'Done',
  })
  await executions.append(run, { kind: 'text-end', messageID: 'answer', channel: 'assistant' })
  await complete(executions, run)
  await publishEvents(
    database.execution,
    mailbox(receiveExecution(createPostgresExecutionResults(database.product))),
  )

  const snapshot = await conversations.snapshot(threadID)
  expect(snapshot.activeTurnID).toBeNull()
  expect(snapshot.messages).toContainEqual({
    id: 'answer',
    kind: 'text',
    author: 'assistant',
    text: 'Done',
    finished: true,
  })

  expect(await executions.checkpoint(threadID)).toEqual({
    entries: ['saved'],
    workspace: 'immutable/',
  })
})

test('roles reject reads across the product and execution schemas', async () => {
  expect((await database.product`select current_user`)[0].current_user).toBe('vid_product')
  expect((await database.execution`select current_user`)[0].current_user).toBe('vid_execution')
  await expect(Promise.resolve(database.product`select * from execution.sessions`)).rejects.toThrow(
    'permission denied',
  )
  await expect(Promise.resolve(database.execution`select * from product.messages`)).rejects.toThrow(
    'permission denied',
  )
})

test('duplicate commands have one winner and conflicting replay fails', async () => {
  const { executions, input } = await fixture()
  await Promise.all([executions.accept(input), executions.accept(input)])
  await expect(executions.accept({ ...input, message: 'Different' })).rejects.toThrow(
    'different input',
  )

  const claims = await Promise.all([executions.claim('one'), executions.claim('two')])
  const runs = claims.filter((run) => run !== null)
  expect(runs).toHaveLength(1)
  await complete(executions, runs[0]!)
})

test('expired ownership is fenced and uncertain work is not automatically rerun', async () => {
  const { executions, input, threadID } = await fixture()
  await executions.accept(input)
  const run = (await executions.claim('lost'))!
  await database.execution`
    update execution.runs
    set lease_until = now() - interval '1 second'
    where turn_id = ${run.turnID}
  `
  await expect(
    executions.append(run, { kind: 'text-start', channel: 'assistant', messageID: 'late' }),
  ).rejects.toThrow('lease lost')

  await executions.expire()
  await expect(complete(executions, run)).rejects.toThrow('lease lost')
  expect(await executions.claim('replacement')).toBeNull()
  expect(
    (await database.execution`select state from execution.runs where turn_id = ${run.turnID}`)[0]
      .state,
  ).toBe('interrupted')

  expect(await executions.checkpoint(threadID)).toEqual({ entries: [], workspace: null })
})

test('late stop targets its original run and never cancels the next run', async () => {
  const { executions, input } = await fixture()
  await executions.accept(input)
  const first = (await executions.claim('worker'))!
  await complete(executions, first)
  await executions.accept({ ...input, commandID: crypto.randomUUID(), message: 'Continue' })

  const second = (await executions.claim('worker'))!
  await executions.stop({
    commandID: crypto.randomUUID(),
    threadID: first.threadID,
    turnID: first.turnID,
  })
  expect((await executions.controls(second)).cancelled).toBe(false)
  await complete(executions, second)
})

test('out-of-order results wait for missing events and duplicate events never duplicate text', async () => {
  const { threadID, conversations } = await fixture()
  const accept = receiveExecution(createPostgresExecutionResults(database.product))
  const event = {
    eventID: crypto.randomUUID(),
    threadID,
    turnID: crypto.randomUUID(),
    sequence: 2,
    progress: { kind: 'text-start', messageID: 'answer', channel: 'assistant' },
  }
  expect(await accept(event)).toBe(false)
  expect(
    await accept({
      ...event,
      eventID: crypto.randomUUID(),
      sequence: 1,
      progress: { kind: 'started' },
    }),
  ).toBe(true)
  expect(await accept(event)).toBe(true)
  const delta = {
    ...event,
    eventID: crypto.randomUUID(),
    sequence: 3,
    progress: { kind: 'text-delta', messageID: 'answer', channel: 'assistant', delta: 'Hello' },
  }
  expect(await accept(delta)).toBe(true)
  expect(await accept(delta)).toBe(true)
  expect((await conversations.snapshot(threadID)).messages).toContainEqual({
    id: 'answer',
    kind: 'text',
    author: 'assistant',
    text: 'Hello',
    finished: false,
  })
})

test('messages arriving during a run can steer it; messages after sealing wait for the next run', async () => {
  const { executions, input } = await fixture()
  await executions.accept(input)
  const first = (await executions.claim('worker'))!

  const steering = { ...input, commandID: crypto.randomUUID(), message: 'Use blue' }
  await executions.accept(steering)
  expect((await executions.controls(first)).messages).toEqual([steering])
  await executions.delivered(steering.commandID)
  await executions.seal(first)

  const next = { ...input, commandID: crypto.randomUUID(), message: 'One more' }
  await executions.accept(next)
  expect((await executions.controls(first)).messages).toEqual([])
  expect(await executions.claim('another')).toBeNull()
  await complete(executions, first)

  const second = (await executions.claim('another'))!
  expect(second.message).toBe('One more')
  await complete(executions, second)
})

test('terminal results settle partial text and running activities before ending the stream', async () => {
  const { threadID, conversations } = await fixture()
  const accept = receiveExecution(createPostgresExecutionResults(database.product))
  const base = { threadID, turnID: crypto.randomUUID() }
  await accept({
    ...base,
    eventID: crypto.randomUUID(),
    sequence: 1,
    progress: { kind: 'started' },
  })
  await accept({
    ...base,
    eventID: crypto.randomUUID(),
    sequence: 2,
    progress: { kind: 'step', messageID: 'render', label: 'Rendering', state: 'running' },
  })
  await accept({
    ...base,
    eventID: crypto.randomUUID(),
    sequence: 3,
    progress: { kind: 'text-start', messageID: 'answer', channel: 'assistant' },
  })
  await accept({
    ...base,
    eventID: crypto.randomUUID(),
    sequence: 4,
    progress: { kind: 'finished', outcome: 'interrupted', reason: 'lease expired' },
  })

  const snapshot = await conversations.snapshot(threadID)
  expect(snapshot.activeTurnID).toBeNull()
  expect(snapshot.messages).toContainEqual({
    id: 'render',
    kind: 'activity',
    activity: { kind: 'step', label: 'Rendering', state: 'failed' },
  })
  expect(snapshot.messages).toContainEqual({
    id: 'answer',
    kind: 'text',
    author: 'assistant',
    text: '',
    finished: true,
  })
})

test('an outbox publish failure leaves the command available for retry', async () => {
  const { conversations, input, executions } = await fixture()
  await conversations.accept(input)
  await expect(
    publishCommands(
      database.product,
      mailbox(async () => {
        throw new Error('redis unavailable')
      }),
    ),
  ).rejects.toThrow('redis unavailable')

  const [command] = await database.product`
    select delivered from product.outbox where command_id = ${input.commandID}
  `
  expect(command.delivered).toBe(false)

  await publishCommands(database.product, mailbox(receiveCommand(executions)))
  const run = (await executions.claim('recovered'))!
  expect(run.threadID).toBe(input.threadID)
  await complete(executions, run)
})
