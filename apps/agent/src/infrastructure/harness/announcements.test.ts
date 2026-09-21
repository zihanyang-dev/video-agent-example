import { describe, expect, test } from 'bun:test'
import { createAnnouncements, readAnnouncement } from './announcements'

const announce = (id: string, activityType: string, content: unknown): string =>
  `::vid ${JSON.stringify({ id, activityType, content })}`

describe('what a command prints', () => {
  test('ordinary output reaches nobody', () => {
    const announcements = createAnnouncements()

    const observations = announcements.fromOutput(
      [
        'ffmpeg version 5.1.9 Copyright (c) 2000-2026',
        '  Stream #0:0: Video: h264, yuv420p, 1920x1080, 24 fps',
        'frame=   48 fps=0.0 q=28.0 size=  256kB time=00:00:01.95',
        '/work/clips/a.mp4',
      ].join('\n'),
    )

    expect(observations).toHaveLength(0)
  })

  test('an announcement repeated as output accumulates is shown once', () => {
    const announcements = createAnnouncements()
    const line = announce('cut', 'step', { label: 'Cutting clip', state: 'running' })

    const first = announcements.fromOutput(line)
    const again = announcements.fromOutput(`${line}\nError opening output file`)
    const third = announcements.fromOutput(`${line}\nError opening output file\nmore`)

    expect([first.length, again.length, third.length]).toEqual([1, 0, 0])
  })

  test('settling an activity is the same message again, not a second one', () => {
    const announcements = createAnnouncements()
    announcements.fromOutput(announce('cut', 'step', { label: 'Cutting clip', state: 'running' }))

    const settled = announcements.fromOutput(
      announce('cut', 'step', { label: 'Cutting clip', state: 'done' }),
    )

    expect(settled).toHaveLength(1)
    expect(settled[0]).toMatchObject({ kind: 'step', messageID: 'cut' })
  })
})

describe('malformed announcements', () => {
  test.each([
    ['no prefix', '{"id":"a","activityType":"step"}'],
    ['half a line', '::vid {"id":"a","activityT'],
    ['an activity type nobody defined', announce('a', 'nonsense', {})],
    ['a state outside the set', announce('a', 'step', { label: 'x', state: 'nope' })],
    ['no id', announce('', 'step', { label: 'x', state: 'done' })],
    ['no label', announce('a', 'step', { label: '', state: 'done' })],
  ])('%s is not an announcement', (_name, line) => {
    expect(readAnnouncement(line)).toBeNull()
  })
})

describe('when a turn ends', () => {
  test('a step still running is closed, keeping the label', () => {
    const announcements = createAnnouncements()
    announcements.fromOutput(announce('probe', 'step', { label: 'Probing media', state: 'done' }))
    announcements.fromOutput(
      announce('render', 'step', { label: 'Rendering montage', state: 'running' }),
    )

    const abandoned = announcements.settle()

    expect(abandoned).toHaveLength(1)
    expect(abandoned[0]).toMatchObject({
      messageID: 'render',
      label: 'Rendering montage',
      state: 'failed',
    })
  })

  test('nothing is closed twice', () => {
    const announcements = createAnnouncements()
    announcements.fromOutput(announce('render', 'step', { label: 'Rendering', state: 'running' }))

    announcements.settle()

    expect(announcements.settle()).toHaveLength(0)
  })

  test('an artifact carries what the script said', () => {
    const announcements = createAnnouncements()

    const observations = announcements.fromOutput(
      announce('a1', 'artifact', { url: 'https://objects/out.mp4', role: 'final' }),
    )

    expect(observations[0]).toMatchObject({
      kind: 'artifact',
      path: 'https://objects/out.mp4',
      role: 'final',
    })
  })
})
