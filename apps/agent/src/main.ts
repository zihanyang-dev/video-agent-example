import { readWorkerEnv } from '@vid/config'
import { startWorker } from './worker'

const stop = new AbortController()
const shutdown = () => stop.abort()
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
try {
  const worker = await startWorker(readWorkerEnv(), { signal: stop.signal })
  await worker.done
} finally {
  process.removeListener('SIGTERM', shutdown)
  process.removeListener('SIGINT', shutdown)
}
