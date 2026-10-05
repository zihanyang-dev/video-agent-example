import { expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ChatCreation } from './chat-creation'
import { useMessageSubmission } from './use-message-submission'

function MessageRecovery() {
  const state = useMessageSubmission({ userID: 'alice', threadID: 'chat' })
  return createElement('p', { 'data-blocked': state.hasPending }, state.error)
}

for (const Component of [ChatCreation, MessageRecovery]) {
  test(`${Component.name} remains readable and blocks replacement after retained intent corruption`, () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      'localStorage',
    )
    const storage: Storage = {
      length: 1,
      key: () => 'retained-corrupt-intent',
      getItem: () => 'private_pending_request_not_json',
      setItem: () => {
        throw new Error('Must not replace a retained request')
      },
      removeItem: () => {
        throw new Error('Must not discard an unknown receipt')
      },
      clear: () => {
        throw new Error('Must not clear another account')
      },
    }
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: storage,
    })
    const client = new QueryClient()
    try {
      const html = renderToString(
        createElement(QueryClientProvider, {
          client,
          children: createElement(Component, {
            userID: 'alice',
            create: async () => {
              throw new Error('Must not create a replacement Chat')
            },
          }),
        }),
      )
      expect(html).toContain('Check Chat history before clearing browser data.')
      expect(html).not.toContain('private_pending_request_not_json')
      expect(html).toMatch(/disabled=|data-blocked="true"/)
    } finally {
      client.clear()
      if (descriptor)
        Object.defineProperty(globalThis, 'localStorage', descriptor)
      else Reflect.deleteProperty(globalThis, 'localStorage')
    }
  })
}
