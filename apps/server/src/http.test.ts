import { expect, test } from 'bun:test'
import { generateSpecs } from 'hono-openapi'
import { uploadMimeTypeSchema } from '@vid/contract/http'
import { createRouter } from './http'

test('offline native routes expose the product operations without the auth SDK paths', async () => {
  const app = createRouter()
  const spec = await generateSpecs(app)
  expect(spec.paths['/api/threads/{threadID}/runs/{runID}/events']?.post).toBeDefined()
  expect(spec.paths['/api/threads/{threadID}/events']).toBeUndefined()
  expect(spec.paths['/api/threads']?.post?.requestBody).toBeDefined()
  expect(spec.paths['/api/auth/sign-out']).toBeUndefined()
  const response = await app.request('/not-a-route')
  expect(response.status).toBe(404)
})

test('upload documentation only advertises media types accepted by the byte boundary', async () => {
  const spec = await generateSpecs(createRouter())
  const operation = spec.paths['/api/threads/{threadID}/assets']?.post
  const body = operation?.requestBody
  if (!body || !('content' in body)) throw new Error('Missing upload body metadata')
  const allowed = [...uploadMimeTypeSchema.options].sort()
  expect(Object.keys(body.content).sort()).toEqual(allowed)
  const contentType = operation.parameters?.find(
    (parameter) =>
      !('$ref' in parameter) && parameter.in === 'header' && parameter.name === 'Content-Type',
  )
  if (!contentType || '$ref' in contentType)
    throw new Error('Missing upload Content-Type parameter')
  expect(contentType).toMatchObject({
    required: true,
    schema: { enum: uploadMimeTypeSchema.options },
  })
})

test('logout rejects unsupported methods before reading identity or accepting a body', async () => {
  const response = await createRouter().request('/api/logout', {
    method: 'GET',
  })
  expect(response.status).toBe(405)
  expect(response.headers.get('allow')).toBe('POST')
})
