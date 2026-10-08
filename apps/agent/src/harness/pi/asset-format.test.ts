import { expect, test } from 'bun:test'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { retainPiAssets } from './session'

test('malformed trusted asset receipt cannot silently disappear during recovery', () => {
  const manager = SessionManager.inMemory('/')
  const runID = crypto.randomUUID()
  manager.appendCustomEntry('platform-asset', {
    runID,
    asset: { assetID: crypto.randomUUID(), name: 'lost-export.bin' },
  })
  expect(() => retainPiAssets(manager, runID)).toThrow('Invalid native Pi asset receipt')
})
