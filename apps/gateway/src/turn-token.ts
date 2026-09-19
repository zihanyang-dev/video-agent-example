/**
 * A token good for one turn's spending, and nothing else.
 *
 * Signed rather than looked up, so this process needs no database and no shared state with
 * the one that mints them -- a gateway that had to ask something else whether a token was
 * real would be down whenever that something was.
 *
 * It carries no user, no account and no entitlement. It says which turn is spending, which
 * is what a provider call has to be attributable to. Anything about who may spend how much
 * was decided before the token existed.
 */
import type { TurnToken } from './forward'

const encoder = new TextEncoder()

/** Long enough for a render to finish, short enough that a leaked one is nearly spent. */
export const TOKEN_LIFETIME_MS = 60 * 60 * 1000

export const mintTurnToken = async (
  secret: string,
  claims: Omit<TurnToken, 'expiresAt'>,
  now: number,
): Promise<string> => {
  const body = JSON.stringify({ ...claims, expiresAt: now + TOKEN_LIFETIME_MS })
  const payload = base64(encoder.encode(body))
  return `${payload}.${await sign(secret, payload)}`
}

export const createTokenReader =
  (secret: string, now: () => number) =>
  async (header: string | undefined): Promise<TurnToken | null> => {
    const presented = header?.startsWith('Bearer ') === true ? header.slice(7) : header
    if (presented === undefined || presented === '') return null

    const [payload, signature] = presented.split('.')
    if (payload === undefined || signature === undefined) return null

    // Constant time, because a comparison that returns early tells an attacker how much of
    // a forged signature was right.
    const expected = await sign(secret, payload)
    if (!timingSafeEqual(signature, expected)) return null

    const claims = read(payload)
    if (claims === null || claims.expiresAt <= now()) return null

    return claims
  }

const sign = async (secret: string, payload: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return base64(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(payload))))
}

const read = (payload: string): TurnToken | null => {
  try {
    const claims = JSON.parse(atob(unpad(payload))) as Partial<TurnToken>
    if (typeof claims.turnID !== 'string' || claims.turnID === '') return null
    if (typeof claims.threadID !== 'string' || claims.threadID === '') return null
    if (typeof claims.expiresAt !== 'number') return null

    return { turnID: claims.turnID, threadID: claims.threadID, expiresAt: claims.expiresAt }
  } catch {
    // Anything that is not a token we wrote. There is one recovery -- ask for a new one --
    // so there is no reason to say which way it was malformed.
    return null
  }
}

const base64 = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')

const unpad = (value: string): string => value.replaceAll('-', '+').replaceAll('_', '/')

const timingSafeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false

  let differences = 0
  for (let at = 0; at < a.length; at++) differences |= a.charCodeAt(at) ^ b.charCodeAt(at)
  return differences === 0
}
