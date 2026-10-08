import { expect, test } from 'bun:test'
import { generateSpecs } from 'hono-openapi'
import { uploadMimeTypeSchema } from '@vid/contract/http'
import { createRouter } from './http'
import { betterAuth } from 'better-auth'
import { authenticationOptions } from './identity/authentication'

const authentication = betterAuth(
  authenticationOptions(undefined, {
    baseURL: 'http://localhost:8787',
    secret: 'offline-auth-boundary-fixture-secret',
    githubClientID: 'fixture',
    githubClientSecret: 'fixture-secret',
  }),
)

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

test('observation documentation names public cursors rather than run ordinals', async () => {
  const spec = await generateSpecs(createRouter())
  const operation = spec.paths['/api/threads/{threadID}/runs/{runID}/events']?.post
  expect(operation?.description).toContain('public cursors')
  expect(operation?.description).not.toMatch(/signed-int64 ordinals/)
  const cursor = operation?.parameters?.find(
    (parameter) =>
      !('$ref' in parameter) && parameter.in === 'header' && parameter.name === 'Last-Event-ID',
  )
  if (!cursor || '$ref' in cursor) throw new Error('Missing observation cursor documentation')
  expect(cursor.description).toMatch(/cursor/i)
  expect(cursor.description).not.toMatch(/ordinal/i)
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

test('authentication bodies share the product byte limit before SDK parsing', async () => {
  const response = await createRouter().request(
    '/api/auth/sign-in/social',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:8787' },
      body: JSON.stringify({ padding: 'x'.repeat(65536) }),
    },
    {
      authentication,
      bodyCollection: { signal: new AbortController().signal, timeoutMs: 1000 },
    },
  )
  expect(response.status).toBe(413)
})

test('authentication stops stalled request bodies at the collection deadline', async () => {
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true
    },
  })
  const response = await createRouter().request(
    '/api/auth/sign-in/social',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:8787' },
      body,
    },
    {
      authentication,
      bodyCollection: { signal: new AbortController().signal, timeoutMs: 10 },
    },
  )
  expect(response.status).toBe(408)
  expect(cancelled).toBe(true)
  expect(body.locked).toBe(false)
})
