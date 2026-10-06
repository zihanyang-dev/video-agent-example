import { expect, spyOn, test } from 'bun:test'
import { eventually } from '../integration/postgres-proxy-fixture'

test('native fixture polling does not expire early when the wall clock advances', async () => {
  let wallTime = 0
  const clock = spyOn(Date, 'now').mockImplementation(() => {
    wallTime += 60000
    return wallTime
  })
  let ready = false
  const timer = setTimeout(() => {
    ready = true
  }, 20)
  try {
    await eventually(() => ready, 100)
    expect(ready).toBe(true)
  } finally {
    clearTimeout(timer)
    clock.mockRestore()
  }
})
