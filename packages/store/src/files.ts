/**
 * Object storage: the truth about files.
 *
 * A sandbox is rented for one turn and destroyed, so nothing in it survives. Whatever the
 * next turn -- or the browser -- needs has to be here first (architecture.md §3).
 *
 * Two shapes because there are two callers. The agent process moves bytes: it carries a
 * thread's working files into a sandbox at the start of a turn and back out at the end. A
 * script inside the sandbox never holds a storage credential, so it is handed a short-lived
 * URL instead -- and the agent never learns which URL a script used, because the script
 * announces the result rather than returning it (architecture.md §8).
 */
export type Files = {
  list: (prefix: string) => Promise<readonly string[]>
  get: (key: string) => Promise<Uint8Array>
  put: (key: string, bytes: Uint8Array) => Promise<void>
  /** Handed into the sandbox so a script can publish a render without a key. */
  uploadUrl: (key: string) => Promise<string>
  /** Handed to the browser. What ends up in an artifact activity. */
  downloadUrl: (key: string) => Promise<string>
}
