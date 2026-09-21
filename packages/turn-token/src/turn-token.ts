/**
 * Agent and gateway share signature rules without importing either application. Local
 * verification lets the gateway authorize a sandbox request without calling the agent.
 * The token attributes requests to a turn; it does not enforce billing or entitlements.
 */
import { z } from 'zod'

const TurnToken = z.object({
  turnID: z.string().min(1),
  threadID: z.string().min(1),
  expiresAt: z.number(),
})

export type TurnToken = z.infer<typeof TurnToken>

const encoder = new TextEncoder()

/** Tokens expire one hour after issuance; expiration does not track whether a run has ended. */
export const TOKEN_LIFETIME_MS = 60 * 60 * 1000

export const mintTurnToken = async (
  secret: string,
  claims: Omit<TurnToken, 'expiresAt'>,
  nowMs: number,
): Promise<string> => {
  const body = JSON.stringify({ ...claims, expiresAt: nowMs + TOKEN_LIFETIME_MS })
  const encodedClaims = encodeBase64Url(encoder.encode(body))
  return `${encodedClaims}.${await sign(secret, encodedClaims)}`
}

export const createTokenReader =
  (secret: string, nowMs: () => number) =>
  async (header: string | undefined): Promise<TurnToken | null> => {
    const presented = header?.startsWith('Bearer ') === true ? header.slice(7) : header
    if (presented === undefined || presented === '') return null

    const [encodedClaims, signature] = presented.split('.')
    if (encodedClaims === undefined || signature === undefined) return null

    // Constant time, because a comparison that returns early tells an attacker how much of
    // a forged signature was right.
    const expected = await sign(secret, encodedClaims)
    if (!timingSafeEqual(signature, expected)) return null

    const claims = decodeClaims(encodedClaims)
    if (claims === null || claims.expiresAt <= nowMs()) return null

    return claims
  }

const sign = async (secret: string, encodedClaims: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return encodeBase64Url(
    new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(encodedClaims))),
  )
}

const decodeClaims = (encodedClaims: string): TurnToken | null => {
  let decoded: unknown
  try {
    decoded = JSON.parse(atob(encodedClaims.replaceAll('-', '+').replaceAll('_', '/')))
  } catch {
    // Invalid encoding and JSON both require a newly issued token; do not expose which failed.
    return null
  }

  const parsed = TurnToken.safeParse(decoded)
  return parsed.success ? parsed.data : null
}

const encodeBase64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')

const timingSafeEqual = (presented: string, expected: string): boolean => {
  if (presented.length !== expected.length) return false

  let differences = 0
  for (let index = 0; index < presented.length; index++) {
    differences |= presented.charCodeAt(index) ^ expected.charCodeAt(index)
  }

  return differences === 0
}
