/** Framing only: each caller owns its complete provider envelopes and policy. */
export function modelStream(envelopes: readonly unknown[]) {
  const body = envelopes.map((envelope) => `data: ${JSON.stringify(envelope)}\n\n`).join('')
  return new Response(`${body}data: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  })
}
