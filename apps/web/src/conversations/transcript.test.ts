import { expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Transcript } from './transcript'

test('transcript renders public text as escaped content rather than executable markup', () => {
  const html = renderToStaticMarkup(
    createElement(Transcript, {
      messages: [
        {
          messageID: 'public-message',
          role: 'assistant',
          text: '<script>secret()</script>',
        },
      ],
    }),
  )
  expect(html).toContain('Video assistant')
  expect(html).toContain('&lt;script&gt;secret()&lt;/script&gt;')
  expect(html).not.toContain('<script>')
})

test('empty transcript presents an idea prompt without implying a generated artifact', () => {
  const html = renderToStaticMarkup(createElement(Transcript, { messages: [] }))
  expect(html).toContain('Every video starts with an idea.')
  expect(html).not.toContain('<video')
})
