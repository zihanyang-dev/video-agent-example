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
test('an archived Chat shows authoritative active runs but cannot submit another message', () => {
  const client = new QueryClient()
  client.setQueryData(threadQuery(scope).queryKey, {
    thread: {
      threadID: scope.threadID,
      title: 'My Chat',
      createdAt: '2026-10-04T00:00:00Z',
      archivedAt: '2026-10-04T01:00:00Z',
    },
  })
  client.setQueryData(messagesQuery(scope).queryKey, {
    messages: [],
    failedRuns: [],
    activeRuns: [
      {
        runID: '22222222-2222-4222-8222-222222222222',
        messageID: '33333333-3333-4333-8333-333333333333',
        status: 'stopping',
      },
    ],
  })
  const html = renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(ChatWorkspace, { scope }),
    ),
  )
  expect(html).toContain('My Chat')
  expect(html).toContain('Archived')
  expect(html).toContain('stopping')
  expect(html).not.toContain('Send message')
  expect(html).not.toContain('Rename Chat')
  client.clear()
})
