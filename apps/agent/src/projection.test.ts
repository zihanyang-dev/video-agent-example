/**
 * What a person is allowed to see.
 *
 * Every case here is a promise to a user, not a check that the code does what it does:
 * the agent's working stays off their screen, a spinner never outlives the turn that
 * started it, and an announcement that arrives three times is shown once.
 */
import { describe, expect, test } from 'bun:test'
import { createProjection, readAnnouncement } from './projection'

const announce = (id: string, activityType: string, content: unknown): string =>
  `::vid ${JSON.stringify({ id, activityType, content })}`

const step = (label: string, state: string) => ({ label, state })

describe('what a command prints', () => {
  test('ordinary output reaches nobody', () => {
    const projection = createProjection()

    const events = projection.fromOutput(
      [
        'ffmpeg version 5.1.9 Copyright (c) 2000-2026',
        '  Stream #0:0: Video: h264, yuv420p, 1920x1080, 24 fps',
        'frame=   48 fps=0.0 q=28.0 size=  256kB time=00:00:01.95',
        '/work/clips/a.mp4',
      ].join('\n'),
    )

    expect(events).toHaveLength(0)
  })

  test('an announcement repeated as output accumulates is shown once', () => {
    const projection = createProjection()
    const line = announce('cut', 'step', step('Cutting clip', 'running'))

    const first = projection.fromOutput(line)
    const again = projection.fromOutput(`${line}\nError opening output file`)
    const third = projection.fromOutput(`${line}\nError opening output file\nmore`)

    expect([first.length, again.length, third.length]).toEqual([1, 0, 0])
  })

  test('settling an activity is the same message again, not a second one', () => {
    const projection = createProjection()
    projection.fromOutput(announce('cut', 'step', step('Cutting clip', 'running')))

    const settled = projection.fromOutput(announce('cut', 'step', step('Cutting clip', 'done')))

    expect(settled).toHaveLength(1)
    expect(settled[0]).toMatchObject({ type: 'ACTIVITY_SNAPSHOT', messageId: 'cut' })
  })
})

describe('malformed announcements', () => {
  test.each([
    ['no prefix', '{"id":"a","activityType":"step"}'],
    ['half a line', '::vid {"id":"a","activityT'],
    ['an activity type nobody defined', announce('a', 'nonsense', {})],
    ['a state outside the set', announce('a', 'step', step('x', 'nope'))],
    ['no id', announce('', 'step', step('x', 'done'))],
    ['no label', announce('a', 'step', step('', 'done'))],
  ])('%s is not an announcement', (_name, line) => {
    expect(readAnnouncement(line)).toBeNull()
  })
})

describe('when a turn ends', () => {
  test('a step still running is closed, keeping the label', () => {
    const projection = createProjection()
    projection.fromOutput(announce('probe', 'step', step('Probing media', 'done')))
    projection.fromOutput(announce('render', 'step', step('Rendering montage', 'running')))

    const abandoned = projection.settle()

    expect(abandoned).toHaveLength(1)
    expect(abandoned[0]).toMatchObject({
      messageId: 'render',
      content: { label: 'Rendering montage', state: 'failed' },
    })
  })

  test('nothing is closed twice', () => {
    const projection = createProjection()
    projection.fromOutput(announce('render', 'step', step('Rendering', 'running')))

    projection.settle()

    expect(projection.settle()).toHaveLength(0)
  })

  test('an artifact carries what the script said', () => {
    const projection = createProjection()

    const events = projection.fromOutput(
      announce('a1', 'artifact', { url: 'https://objects/out.mp4', role: 'final' }),
    )

    expect(events[0]).toMatchObject({
      activityType: 'artifact',
      content: { url: 'https://objects/out.mp4', role: 'final' },
    })
  })
})
