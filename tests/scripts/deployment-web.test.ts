import { expect, test } from 'bun:test'

const origin = process.env.DEPLOYMENT_WEB_URL!
test('built React fallback and same-origin native auth routes are served by Caddy', async () => {
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
  const home = await fetch(origin)
  expect(home.status).toBe(200)
  const html = await home.text()
  const bundle = html.match(/src="([^"]+\.js)"/)?.[1]
  expect(bundle).toBeDefined()
  const script = await fetch(new URL(bundle!, origin))
  expect(script.status).toBe(200)
  expect(script.headers.get('content-type')).toContain('javascript')
  expect((await script.text()).length).toBeGreaterThan(1000)
  const fallback = await fetch(`${origin}/chat/fixture`)
  expect(await fallback.text()).toBe(html)
  const privateRoute = await fetch(`${origin}/api/threads`)
  expect(privateRoute.status).toBe(401)
}, 20000)
