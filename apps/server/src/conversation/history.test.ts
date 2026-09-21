/**
 * What a page load gets, a day after the work was done.
 *
 * The case that matters is the one a same-day test cannot see: a link signed when the
 * artifact was delivered has expired by the time anyone reloads.
 */
import { EventType, type Message } from '@ag-ui/core'
import { ARTIFACT, STEP } from '@vid/contract'
import { describe, expect, test } from 'bun:test'
import { snapshotOf } from './history'

const sign = async (key: string): Promise<string> => `https://objects/${key}?expires=soon`

const stored = (content: unknown): Message =>
  ({ id: 'a1', role: 'activity', activityType: ARTIFACT, content }) as unknown as Message

describe('an artifact in the record', () => {
  test('reaches the browser as a link minted now', async () => {
    const snapshot = await snapshotOf([stored({ key: 'threads/t1/cut.mp4', role: 'final' })], sign)

    expect(snapshot).toMatchObject({
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [{ content: { url: 'https://objects/threads/t1/cut.mp4?expires=soon' } }],
    })
  })

  test('never hands over the key it was stored under', async () => {
    const snapshot = await snapshotOf([stored({ key: 'threads/t1/cut.mp4', role: 'final' })], sign)

    // A key is an internal path, and the contract exists to keep those off the screen.
    expect(JSON.stringify(snapshot)).not.toContain('"key"')
  })

  test('keeps whether it was a cut or something to look at', async () => {
    const snapshot = await snapshotOf(
      [stored({ key: 'threads/t1/rough.mp4', role: 'preview' })],
      sign,
    )

    expect(snapshot).toMatchObject({ messages: [{ content: { role: 'preview' } }] })
  })
})

describe('everything else in the record', () => {
  test('is passed through, because it is already in the protocol shape', async () => {
    const said: Message = { id: 'm1', role: 'assistant', content: 'here it is' }
    const step = {
      id: 's1',
      role: 'activity',
      activityType: STEP,
      content: { label: 'Rendering', state: 'done' },
    } as unknown as Message

    const snapshot = await snapshotOf([said, step], sign)

    expect(snapshot).toMatchObject({ messages: [said, step] })
  })

  test('survives an artifact that cannot be signed', async () => {
    const angry = async (): Promise<string> => {
      throw new Error('object storage is unreachable')
    }

    // One dead thumbnail is a better page than no page -- but it must not take the
    // conversation with it.
    await expect(
      snapshotOf([{ id: 'm1', role: 'assistant', content: 'still readable' }], angry),
    ).resolves.toMatchObject({ messages: [{ content: 'still readable' }] })
  })
})
