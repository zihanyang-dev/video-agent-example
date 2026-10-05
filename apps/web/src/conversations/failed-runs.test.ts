import { expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ChatWorkspace } from './chat-workspace'
import { threadQuery, messagesQuery } from './queries'

const scope = {
  userID: 'alice',
  threadID: '11111111-1111-4111-8111-111111111111',
}
const messageID = '22222222-2222-4222-8222-222222222222'
const runID = '33333333-3333-4333-8333-333333333333'

test.each([
  ['execution-error', 'could not finish'],
  ['interrupted', 'interrupted'],
  ['sandbox-recovery-required', 'environment needs recovery'],
] as const)(
  'reload renders persisted %s at its accepted message without an active run',
  (reason, description) => {
    const client = new QueryClient()
    client.setQueryData(threadQuery(scope).queryKey, {
      thread: {
        threadID: scope.threadID,
        title: 'My Chat',
        createdAt: '2026-10-04T00:00:00Z',
        archivedAt: null,
      },
    })
    client.setQueryData(messagesQuery(scope).queryKey, {
      messages: [
        {
          messageID,
          role: 'user',
          text: 'First request',
          createdAt: '2026-10-04T00:00:00Z',
        },
        {
          messageID: '44444444-4444-4444-8444-444444444444',
          role: 'user',
          text: 'Second request',
          createdAt: '2026-10-04T00:01:00Z',
        },
      ],
      activeRuns: [],
      failedRuns: [{ runID, messageID, reason }],
    })
    const render = () =>
      renderToStaticMarkup(
        createElement(
          QueryClientProvider,
          { client },
          createElement(ChatWorkspace, { scope }),
        ),
      )
    for (let reload = 0; reload < 2; reload++) {
      const html = render()
      expect(html).toContain(description)
      expect(html.match(/role="alert"/g)).toHaveLength(1)
      expect(html.indexOf(description)).toBeGreaterThan(
        html.indexOf('First request'),
      )
      expect(html.indexOf(description)).toBeLessThan(
        html.indexOf('Second request'),
      )
      expect(html).not.toContain('Current run')
      expect(html).not.toContain('Video assistant')
    }
    client.clear()
  },
)
