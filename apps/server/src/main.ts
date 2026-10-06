import { readServerEnv } from '@vid/config'
import { startServer } from './server'

const stop = new AbortController()
const shutdown = () => stop.abort()
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
try {
  const runtime = await startServer(readServerEnv(), { signal: stop.signal })
  await runtime.done
} catch {
  // Owners retain detailed causes for library callers; native error rendering
  // can include private driver arguments or payloads and is not a log boundary.
  console.error('Process stopped after failure', { stage: 'server-entrypoint' })
  process.exitCode = 1
} finally {
  process.removeListener('SIGTERM', shutdown)
  process.removeListener('SIGINT', shutdown)
}
