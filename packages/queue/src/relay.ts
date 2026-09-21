/**
 * Polls an owner's durable outbox until shutdown. The owner decides which records remain
 * pending and when a successful publish is committed; a failure escapes to its lifecycle
 * supervisor rather than silently discarding a batch.
 */
export const relay = async (options: {
  publishPending: () => Promise<void>
  signal: AbortSignal
  intervalMs: number
}): Promise<void> => {
  while (!options.signal.aborted) {
    await options.publishPending()
    await Bun.sleep(options.intervalMs)
  }
}
