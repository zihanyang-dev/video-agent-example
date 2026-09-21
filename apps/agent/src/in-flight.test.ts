/**
 * The rule that has to hold before anything runs concurrently.
 *
 * The cases here are the ones concurrency creates: two messages for one thread, a turn that
 * ends at the wrong moment, and two messages that must not overtake each other.
 */
import { describe, expect, test } from 'bun:test'
import { createInFlight, type Steerable } from './in-flight'

const recorder = (): Steerable & { heard: string[]; stopped: () => boolean } => {
  const heard: string[] = []
  let asked = false
  return {
    heard,
    stopped: () => asked,
    steer: async (message) => {
      heard.push(message)
    },
    interrupt: async () => {
      asked = true
    },
  }
}

describe('a thread already working', () => {
  test('takes the message into the turn that is running', () => {
    const flight = createInFlight()
    const turn = recorder()
    flight.claim('t1', turn)

    expect(flight.offer('t1', 'make it tighter')).toBe(true)
  })

  test('will not let a second turn start on it', () => {
    const flight = createInFlight()
    flight.claim('t1', recorder())

    // Two turns on one thread carry the same workspace in twice and overwrite each other.
    expect(() => flight.claim('t1', recorder())).toThrow('already has a turn')
  })

  test('does not stop a different thread from starting', () => {
    const flight = createInFlight()
    flight.claim('t1', recorder())

    expect(() => flight.claim('t2', recorder())).not.toThrow()
  })
})

describe('a thread with nothing running', () => {
  test('refuses the message, so the caller runs a turn for it', () => {
    expect(createInFlight().offer('t1', 'make it tighter')).toBe(false)
  })

  test('refuses it again once the turn has finished', () => {
    const flight = createInFlight()
    const done = flight.claim('t1', recorder())
    done()

    expect(flight.offer('t1', 'make it tighter')).toBe(false)
  })
})

describe('messages typed one after another', () => {
  test('reach the turn in the order they were typed', async () => {
    const flight = createInFlight()
    const heard: string[] = []
    // A harness that is slow on the first message and quick on the second: without a chain
    // the second overtakes the first.
    const slowFirst: Steerable = {
      steer: async (message) => {
        if (message === 'first') await Bun.sleep(20)
        heard.push(message)
      },
      interrupt: async () => {},
    }
    flight.claim('t1', slowFirst)

    flight.offer('t1', 'first')
    flight.offer('t1', 'second')
    await Bun.sleep(60)

    expect(heard).toEqual(['first', 'second'])
  })
})

describe('stopping a turn', () => {
  test('reaches the turn that is running', async () => {
    const flight = createInFlight()
    const turn = recorder()
    flight.claim('t1', turn)

    expect(flight.stop('t1')).toBe(true)
    await Bun.sleep(10)
    expect(turn.stopped()).toBe(true)
  })

  test('is refused for a thread this process is not running', () => {
    // Every agent hears every stop; only one of them owns the thread.
    expect(createInFlight().stop('t1')).toBe(false)
  })

  test('stops it taking anything else, so what is typed next is its own turn', () => {
    const flight = createInFlight()
    flight.claim('t1', recorder())
    flight.stop('t1')

    expect(flight.offer('t1', 'and make it shorter')).toBe(false)
  })
})

describe('what a drain waits on', () => {
  test('is the threads that are working', () => {
    const flight = createInFlight()
    flight.claim('t1', recorder())
    const done = flight.claim('t2', recorder())

    expect([...flight.busy()].sort()).toEqual(['t1', 't2'])

    done()
    expect(flight.busy()).toEqual(['t1'])
  })
})
