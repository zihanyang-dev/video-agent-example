import { readServerEnv } from '@vid/config'
import { startServer } from './server'

const stop = new AbortController()
const shutdown = () => stop.abort()
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
try {
  const runtime = await startServer(readServerEnv(), { signal: stop.signal })
  await runtime.done
} finally {
  process.removeListener('SIGTERM', shutdown)
  process.removeListener('SIGINT', shutdown)
}
