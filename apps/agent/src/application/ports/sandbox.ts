// SDK tools resolve cwd on the host before delegating I/O. The host root is an empty
// local directory; file contents and commands belong to the sandbox root.
export type SandboxRoots = {
  host: string
  sandbox: string
}

export type ExecOptions = {
  onData: (chunk: Buffer) => void
  signal?: AbortSignal | undefined
  /** Seconds, matching the harness tool timeout. */
  timeout?: number | undefined
}

export type Sandbox = {
  roots: SandboxRoots
  exec: (command: string, cwd: string, options: ExecOptions) => Promise<{ exitCode: number | null }>
  readFile: (path: string) => Promise<Uint8Array>
  access: (path: string) => Promise<void>
  mimeType: (path: string) => Promise<string | null>
  writeFile: (path: string, bytes: Uint8Array) => Promise<void>
  mkdir: (path: string) => Promise<void>
  /** File paths relative to the sandbox root, used to build workspace snapshots. */
  list: () => Promise<readonly string[]>
  destroy: () => Promise<void>
}

export type SandboxSpec = {
  image: string
  network: string
  /** Explicit allowlist; never inherit credentials from the host or harness environment. */
  env: Record<string, string>
}

export type RentSandbox = (spec: SandboxSpec) => Promise<Sandbox>

export const toSandbox =
  (roots: SandboxRoots) =>
  (path: string): string =>
    path.startsWith(roots.host) ? roots.sandbox + path.slice(roots.host.length) : path
