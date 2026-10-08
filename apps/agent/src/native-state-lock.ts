import { dlopen } from 'bun:ffi'
import { mkdir, open, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'

// Process ownership must survive discarded callers and failed-worker GC.
const pinned = new Set<FileHandle>()

/** One supported worker/storage host. SQL expiry is not physical-writer proof.
 * Release explicitly only after writers join; otherwise retain until process exit.
 * No timeout, stale-file unlinking, or cross-region lease stealing is permitted.
 */
export async function acquireNativeStateLock(statePath: string) {
  await mkdir(statePath, { recursive: true, mode: 0o700 })
  const library = dlopen(process.platform === 'linux' ? 'libc.so.6' : 'libSystem.B.dylib', {
    flock: { args: ['i32', 'i32'], returns: 'i32' },
  })
  const file = await open(join(statePath, 'owner.lock'), 'a', 0o600).catch((error: unknown) => {
    library.close()
    throw error
  })
  if (library.symbols.flock(file.fd, 2 | 4) !== 0) {
    await file.close().finally(() => library.close())
    throw new Error('Native session storage already has a physical owner')
  }
  pinned.add(file)
  let closing: Promise<void> | undefined
  return {
    close() {
      closing ??= file
        .close()
        .then(() => {
          pinned.delete(file)
        })
        .finally(() => library.close())
      return closing
    },
  }
}
