import { expect, test } from 'bun:test'
import { generateSpecs } from 'hono-openapi'
import { createRouter } from './http'

test('offline native routes expose the product operations without the auth SDK paths', async () => {
  const app = createRouter()
  const spec = await generateSpecs(app)
  expect(
    spec.paths['/api/threads/{threadID}/runs/{runID}/events']?.post,
  ).toBeDefined()
  expect(spec.paths['/api/threads/{threadID}/events']).toBeUndefined()
  expect(spec.paths['/api/threads']?.post?.requestBody).toBeDefined()
  expect(spec.paths['/api/auth/sign-out']).toBeUndefined()
  const response = await app.request('/not-a-route')
  expect(response.status).toBe(404)
})

test('upload documentation only advertises media types accepted by the byte boundary', async () => {
  const spec = await generateSpecs(createRouter())
  const body = spec.paths['/api/threads/{threadID}/assets']?.post?.requestBody
  if (!body || !('content' in body))
    throw new Error('Missing upload body metadata')
  expect(body.content['text/plain']).toBeDefined()
  expect(body.content['application/octet-stream']).toBeUndefined()
})

test('logout rejects unsupported methods before reading identity or accepting a body', async () => {
  const response = await createRouter().request('/api/logout', {
    method: 'GET',
  })
  expect(response.status).toBe(405)
  expect(response.headers.get('allow')).toBe('POST')
})
