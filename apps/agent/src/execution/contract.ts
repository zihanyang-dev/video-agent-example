import type { WebSource } from '@vid/contract/web-source'
import type { AssetReference } from '@vid/contract/execution'
import type { NativeSandboxReference } from '../sandbox/reference'

/** A database-issued execution capability. The fence/owner must remain valid for every write. */
export type ExecutionLease = Readonly<{
  runID: string
  threadID: string
  text: string
  fence: number
  ownerID: string
  history: unknown
  assets?: readonly AssetReference[]
  nativeRef?: NativeSandboxReference
}>

/** Tool operations address only the worker-assigned sandbox, never a host path or container ID. */
export interface SandboxTools {
  /** Uses supported command abort/kill; unknown mutative outcomes reject.
   * Does not promise process-tree or external paid-job cancellation. */
  execute: (
    request: Readonly<{ command: string; signal: AbortSignal }>,
  ) => Promise<Readonly<{ stdout: string; stderr: string; exitCode: number }>>
  read: (request: Readonly<{ path: string; signal: AbortSignal }>) => Promise<string>
  write: (
    request: Readonly<{ path: string; content: string; signal: AbortSignal }>,
  ) => Promise<void>
}

/** Vendor-independent business capabilities of the lease-assigned sandbox session,
 * not a provider registry or a replica of the native SDK surface. */
export interface SandboxSessionPort extends SandboxTools, SandboxFiles {
  /** Opaque native identity; execution persists it without interpreting provider details. */
  nativeRef: NativeSandboxReference
  /** Pauses after the caller finishes its tools; unknown mutative outcomes reject. Neither external job cancellation nor durable artifact proof. */
  close: () => Promise<void>
}

export interface SandboxFiles {
  readBytes: (path: string, signal: AbortSignal, maxBytes: number) => Promise<Uint8Array>
  writeBytes: (path: string, bytes: Uint8Array, signal: AbortSignal) => Promise<void>
}

export interface AgentHarness {
  /** Uses bounded Pi abort and cleanup, without remote settlement guarantees. */
  turn: (
    request: Readonly<{
      text: string
      history: unknown
      tools: SandboxTools
      signal: AbortSignal
      fileTools?: FileTools
      onText: (delta: string) => void
    }>,
  ) => Promise<Readonly<{ text: string; history: unknown; sources?: readonly WebSource[] }>>
}

export type ExecutionFailure = 'execution-error' | 'interrupted'
export type ExecutionCompletion = {
  sources?: readonly WebSource[] | undefined
  text: string
  history: unknown
  assets?: readonly AssetReference[]
}

export interface ExecutionWrites {
  saveSandbox: (lease: ExecutionLease, reference: NativeSandboxReference) => Promise<boolean>
  quarantine: (lease: ExecutionLease, reason?: ExecutionFailure) => Promise<void>

  renew: (
    lease: ExecutionLease,
    leaseMs: number,
  ) => Promise<'renewed' | 'cancel' | 'lost' | 'recovery-required'>
  appendText: (lease: ExecutionLease, delta: string) => Promise<boolean>

  complete: (lease: ExecutionLease, completion: ExecutionCompletion) => Promise<ExecutionOutcome>
  fail: (lease: ExecutionLease, reason: ExecutionFailure) => Promise<ExecutionOutcome>
  cancel: (lease: ExecutionLease) => Promise<ExecutionOutcome>
}

/** Per-run file authority; the harness implements it, execution owns its result. */
export interface FileTools {
  assigned: readonly AssetReference[]
  prepared: readonly AssetReference[]
  importFile: (request: {
    assetID: string
    path: string
    signal: AbortSignal
  }) => Promise<{ bytes: Uint8Array; mimeType: string }>
  exportFile: (request: {
    path: string
    name: string
    mimeType: string
    signal: AbortSignal
  }) => Promise<AssetReference>
  hasUnknownOutcome: () => boolean
}

export type ExecuteRunDependencies = Readonly<{
  writes: ExecutionWrites
  fileTools?: (
    lease: ExecutionLease,
    sandbox: SandboxSessionPort,
    stopSpending: () => void,
  ) => FileTools
  harness: AgentHarness
  /** The assigned allocator owns connection settings and awaits failed-allocation cleanup. */
  openSandbox: (lease: ExecutionLease, signal: AbortSignal) => Promise<SandboxSessionPort>
}>

export type ExecuteRunOptions = Readonly<{
  leaseMs: number
  pollMs: number
  runTimeoutMs?: number
  /** Worker shutdown, not the database's cancellation authority. */
  signal: AbortSignal
}>

export type ExecutionOutcome = 'completed' | 'cancelled' | 'failed' | 'lost'
