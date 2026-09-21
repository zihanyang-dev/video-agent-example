/**
 * Byte access and temporary download grants for one object store.
 *
 * Callers own key layout, versions and publication decisions. Keeping those decisions out
 * of this package lets the agent persist files and the server sign downloads without either
 * application importing the other application's workspace or conversation rules.
 */
export type Files = {
  list: (prefix: string) => Promise<readonly string[]>
  get: (key: string) => Promise<Uint8Array>
  put: (key: string, bytes: Uint8Array) => Promise<void>
  /** Grants temporary read access to one key without exposing bucket credentials. */
  downloadUrl: (key: string) => Promise<string>
}
