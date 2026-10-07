import { expect, test } from 'bun:test'
import { deploymentRequest } from './deployment-http-fixture'

const origin = process.env.DEPLOYMENT_WEB_URL!
test('same-origin native auth and private API routes are proxied by Caddy', async () => {
  const deadline = performance.now() + 15000
  let ready = false
  let last: Awaited<ReturnType<typeof deploymentRequest>> | undefined
  while (performance.now() < deadline) {
    last = await deploymentRequest(`${origin}/api/auth/get-session`, deadline, true)
    if (last.failures.length && last.status !== undefined)
      throw new AggregateError(last.failures, 'Deployment response failed')
    if (last.status === 200) {
      expect(last.body).toBeNull()
      ready = true
      break
    }
    const remaining = deadline - performance.now()
    if (remaining > 0) await Bun.sleep(Math.min(100, remaining))
  }
  if (!ready) throw new AggregateError(last?.failures ?? [], 'Deployment session unavailable')
  const privateRoute = await deploymentRequest(
    `${origin}/api/threads`,
    deadline,
    false,
    deadline - performance.now(),
  )
  if (privateRoute.failures.length)
    throw new AggregateError(privateRoute.failures, 'Private deployment response failed')
  expect(privateRoute.status).toBe(401)
}, 20000)
