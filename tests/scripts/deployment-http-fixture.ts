/** Native deployment probe: one finite owner through headers and body settlement. */
export async function deploymentRequest(
  url: string,
  deadline: number,
  session: boolean,
  limitMs = 1000,
) {
  const remaining = deadline - performance.now()
  if (remaining <= 0) throw new Error('Deployment HTTP deadline exceeded')
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new Error('Deployment HTTP deadline exceeded')),
    Math.ceil(Math.min(limitMs, remaining)),
  )
  let response: Response | undefined
  let body: unknown
  const failures: unknown[] = []
  try {
    response = await fetch(url, { signal: controller.signal })
    if (session && response.status === 200) body = await response.json()
    else await response.body?.cancel()
    controller.signal.throwIfAborted()
    if (performance.now() >= deadline) throw new Error('Deployment HTTP deadline exceeded')
  } catch (cause) {
    failures.push(cause)
    controller.abort(cause)
  }
  clearTimeout(timer)
  return { status: response?.status, body, failures }
}
