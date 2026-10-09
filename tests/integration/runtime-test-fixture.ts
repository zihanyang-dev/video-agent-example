import { afterEach, test as bunTest } from 'bun:test'

export function runtimeTestFixture(cleanup: () => Promise<void>) {
  // This fixture runs in a dedicated launcher-owned process. On failure, process
  // death contains live owners; it is not a graceful join or permission to erase SQL.
  let bodyState:
    { name: string; pending: boolean; failed: boolean; timeout: number | undefined } | undefined
  function failStop(reason: string): never {
    console.error(`Runtime fixture fail-stop: ${bodyState?.name ?? 'unknown test'}: ${reason}`)
    process.exit(1)
  }
  function test(name: string, body: () => Promise<void>, timeout?: number) {
    return bunTest(
      name,
      async () => {
        const state = { name, pending: true, failed: false, timeout }
        bodyState = state
        try {
          await body()
        } catch (cause) {
          state.failed = true
          console.error(cause)
          throw cause
        } finally {
          state.pending = false
        }
      },
      timeout,
    )
  }

  afterEach(async () => {
    if (bodyState?.pending) {
      const budget =
        bodyState.timeout === undefined ? '' : `; this test timed out after ${bodyState.timeout}ms`
      failStop(`body still pending after Bun timeout${budget}; retaining SQL evidence`)
    }
    if (bodyState?.failed) failStop('body rejected; retaining SQL evidence')
    // Bun's native 5s hook timeout does not join the hook before continuing.
    // Exit first instead of racing/returning with unknown SQL still in flight.
    const watchdog = setTimeout(() => {
      failStop('SQL hook cleanup deadline after 4500ms; no later case may acquire resources')
    }, 4500)
    try {
      await cleanup()
    } catch (cause) {
      console.error(cause)
      failStop('SQL hook cleanup rejected; no later case may acquire resources')
    } finally {
      clearTimeout(watchdog)
    }
  }, 5000)
  return test
}
