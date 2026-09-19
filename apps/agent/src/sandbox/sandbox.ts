/**
 * What every sandbox must provide, and what every implementation must get right.
 *
 * There will be more than one. Local Docker is how this is developed; production needs a
 * vendor that self-hosts or runs inside the Great Firewall, and the three candidates are
 * not interchangeable at the SDK level (architecture.md §5). The port exists so the second
 * implementation is a new file rather than a rewrite of the first.
 *
 * It also holds the part that is identical for all of them -- path translation -- so it is
 * written once rather than copied per vendor.
 *
 * One thing every implementation inherits and none can fix: there is no shell between calls.
 * `cd` and `export` do not survive, so each command starts fresh in `cwd`. That constrains
 * how skills are written, not how adapters are, so it is recorded in architecture.md §5
 * rather than as a constant here that nothing reads.
 *
 * This port assumes the harness runs in our process and treats the sandbox as a remote
 * filesystem and shell (architecture.md §2). That is why paths come in pairs: there is a
 * host side and a sandbox side of every path, and something has to translate. A harness that
 * ran inside the sandbox would not need this port at all.
 */

/**
 * The two ends of every path.
 *
 * `host` is a real, empty directory on this machine. Built-in tools resolve and stat their
 * working directory locally before delegating, so a path that exists only in the sandbox
 * fails before any operation runs. Nothing is ever written there.
 */
export type SandboxRoots = {
  host: string
  sandbox: string
}

export type ExecOptions = {
  onData: (chunk: Buffer) => void
  signal?: AbortSignal | undefined
  /** Seconds. The command is killed, not asked to stop. */
  timeout?: number | undefined
}

export type Sandbox = {
  roots: SandboxRoots
  exec: (command: string, cwd: string, options: ExecOptions) => Promise<{ exitCode: number | null }>
  readFile: (path: string) => Promise<Buffer>
  /** Throws when the path is not readable. That is how a read tool reports a missing file. */
  access: (path: string) => Promise<void>
  /** Null for anything that is not an image a model can be shown. */
  mimeType: (path: string) => Promise<string | null>
  writeFile: (path: string, bytes: Uint8Array) => Promise<void>
  mkdir: (path: string) => Promise<void>
  /** Paths under the sandbox root, relative to it. What a turn carries back out. */
  list: () => Promise<readonly string[]>
  /** Idempotent: a turn that fails half way still ends here. */
  destroy: () => Promise<void>
}

export type SandboxSpec = {
  image: string
  /**
   * Everything the sandbox is allowed to know, spelled out.
   *
   * Never assembled from this process's own environment. A harness hands its tools the
   * host's entire environment -- measured at 73 variables including SSH_AUTH_SOCK and every
   * proxy setting -- and forwarding that is how a developer's credentials end up inside a
   * container running commands a model wrote (architecture.md §5).
   */
  env: Record<string, string>
}

export type RentSandbox = (spec: SandboxSpec) => Promise<Sandbox>

/**
 * Translates a host path to its sandbox counterpart, leaving anything outside the roots
 * alone.
 *
 * Every implementation needs exactly this, which is why it is here. Note what it does not
 * cover: paths inside a command string. Those are the agent's own words, so the system
 * prompt must speak in sandbox paths -- a prompt mentioning a host path produces a command
 * that fails on the first run (architecture.md §5).
 */
export const toSandbox =
  (roots: SandboxRoots) =>
  (path: string): string =>
    path.startsWith(roots.host) ? roots.sandbox + path.slice(roots.host.length) : path
