import { expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Composer } from './composer'

const unused = async () => {}
test('unknown message acceptance offers only an exact retry, never editable replacement input', () => {
  const html = renderToStaticMarkup(
    createElement(Composer, {
      canSend: false,
      isBusy: false,
      hasPending: true,
      send: unused,
      retry: unused,
    }),
  )
  expect(html).toContain('Retry same message')
  expect(html).not.toContain('Send message')
  expect(html).toMatch(/<textarea[^>]*disabled=""/)
  expect(html).not.toContain('type="file"')
})

test('an in-flight exact retry is disabled until its receipt settles', () => {
  const html = renderToStaticMarkup(
    createElement(Composer, {
      canSend: false,
      isBusy: true,
      hasPending: true,
      send: unused,
      retry: unused,
    }),
  )
  expect(html).toMatch(
    /<button[^>]*disabled=""[^>]*>Retry same message<\/button>/,
  )
})
