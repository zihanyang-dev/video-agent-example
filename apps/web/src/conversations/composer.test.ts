import { expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ChatWorkspace } from './chat-workspace'
import { threadQuery, messagesQuery } from './queries'

test.each([false, true])(
  'reload preserves the frozen draft and permits exact retry with active run=%s',
  (hasActiveRun) => {
    const descriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      'localStorage',
    )
    const frozen = JSON.stringify({
      messageID: '22222222-2222-4222-8222-222222222222',
      text: 'Original frozen draft',
      assetIDs: ['33333333-3333-4333-8333-333333333333'],
    })
    const storage: Storage = {
      length: 1,
      key: () => null,
      getItem: () => frozen,
      setItem: () => {
        throw new Error('Do not replace')
      },
      removeItem: () => {},
      clear: () => {},
    }
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: storage,
    })
    const client = new QueryClient()
    const scope = {
      userID: 'alice',
      threadID: '11111111-1111-4111-8111-111111111111',
    }
    client.setQueryData(threadQuery(scope).queryKey, {
      thread: {
        threadID: scope.threadID,
        title: 'Chat',
        createdAt: '2026-10-04T00:00:00Z',
        archivedAt: null,
      },
    })
    client.setQueryData(messagesQuery(scope).queryKey, {
      messages: [],
      activeRuns: hasActiveRun
        ? [
            {
              runID: '44444444-4444-4444-8444-444444444444',
              messageID: '22222222-2222-4222-8222-222222222222',
              status: 'running',
            },
          ]
        : [],
      failedRuns: [],
    })
    try {
      const html = renderToStaticMarkup(
        createElement(
          QueryClientProvider,
          { client },
          createElement(ChatWorkspace, { scope }),
        ),
      )
      expect(html).toContain('Original frozen draft</textarea>')
      expect(html).toMatch(
        /<button(?![^>]*disabled)[^>]*>Retry same message<\/button>/,
      )
      expect(html).not.toContain('Send message')
      expect(html).toMatch(/<textarea[^>]*disabled=""/)
      expect(html).toMatch(/<input[^>]*type="file"[^>]*disabled=""/)
    } finally {
      client.clear()
      if (descriptor)
        Object.defineProperty(globalThis, 'localStorage', descriptor)
      else Reflect.deleteProperty(globalThis, 'localStorage')
    }
  },
)
