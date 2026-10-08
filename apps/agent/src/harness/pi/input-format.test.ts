import { expect, test } from 'bun:test'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { hasPiInput } from './session'

for (const data of [null, {}, { runID: 'corrupted' }]) {
  test(`malformed native input admission cannot become a new task (${JSON.stringify(data)})`, () => {
    const manager = SessionManager.inMemory('/')
    manager.appendCustomEntry('platform-input', data)
    const original = manager.getEntries()
    expect(() => hasPiInput(manager, crypto.randomUUID())).toThrow(
      'Invalid native Pi input admission',
    )
    expect(manager.getEntries()).toEqual(original)
  })
}
