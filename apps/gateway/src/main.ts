/**
 * The only thing a sandbox can reach that belongs to us.
 *
 * Holds every provider credential and nothing else: no database, no object storage, no user
 * data. Someone who got in could spend our generation budget, which is bad, and could not
 * read a single conversation, which is why this is a process of its own (architecture.md §1).
 */
import { readEnv } from './env'
import { createForwarder } from './forward'
import { createTokenReader } from './turn-token'

const env = readEnv()

const app = createForwarder({
  providers: env.PROVIDERS,
  readToken: createTokenReader(env.TURN_TOKEN_SECRET, () => Date.now()),
  onSpend: (token, provider, path) => {
    console.log(`turn ${token.turnID} calling ${provider}${path}`)
  },
})

const server = Bun.serve({ port: env.PORT, fetch: app.fetch })

const stop = (): void => {
  void server.stop()
  process.exit(0)
}

process.on('SIGTERM', stop)
process.on('SIGINT', stop)

console.log(`gateway on ${server.port}, forwarding to ${Object.keys(env.PROVIDERS).join(', ')}`)
