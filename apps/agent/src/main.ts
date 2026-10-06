import { readWorkerEnv } from '@vid/config'
import { startWorker } from './worker'
import { serveWorkerHealth } from './worker-health'

const stop = new AbortController()
const shutdown = () => stop.abort()
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
let worker: Awaited<ReturnType<typeof startWorker>> | undefined
let health: ReturnType<typeof serveWorkerHealth> | undefined
const failures: unknown[] = []
try {
  worker = await startWorker(readWorkerEnv(), { signal: stop.signal })
  health = serveWorkerHealth(worker.health)
  await worker.done
} catch (cause) {
  failures.push(cause)
} finally {
  // Keep the private listener until actual worker/SDK cleanup has joined.
  await worker?.stop().catch((cause: unknown) => {
    if (!failures.includes(cause)) failures.push(cause)
  })
  try {
    await health?.stop(true)
  } catch (cause) {
    failures.push(cause)
  }
  process.removeListener('SIGTERM', shutdown)
  process.removeListener('SIGINT', shutdown)
}
if (failures.length) {
  // Detailed native causes remain in the library owner, not uncaught rendering.
  console.error('Process stopped after failure', {
    stage: 'worker-entrypoint',
    failures: failures.length,
  })
  process.exitCode = 1
}
