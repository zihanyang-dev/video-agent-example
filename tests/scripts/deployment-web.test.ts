import { expect, test } from 'bun:test'

const origin = process.env.DEPLOYMENT_WEB_URL!
test('same-origin native auth and private API routes are proxied by Caddy', async () => {
  const deadline = Date.now() + 15000
  let response: Response | undefined
  while (Date.now() < deadline) {
    response = await fetch(`${origin}/api/auth/get-session`).catch(
      () => undefined,
    )
    if (response?.status === 200) break
    await Bun.sleep(100)
  }
  expect(response?.status).toBe(200)
  expect(await response!.json()).toBeNull()
  const privateRoute = await fetch(`${origin}/api/threads`)
  expect(privateRoute.status).toBe(401)
}, 20000)
