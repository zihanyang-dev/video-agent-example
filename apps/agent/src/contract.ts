import type { WebSource } from '@vid/contract/web-source'
import type { AssetReference } from '@vid/contract/execution'
import type { ConversationContext } from '@vid/contract/conversation-context'
import type { NativeSandboxReference } from './sandbox/reference.ts'

// In-process consumer contracts, not SDK replicas or the shared wire protocol.

export type HarnessEngine = 'pi' | 'openai'

/** A database-issued execution capability. The fence/owner must remain valid for every write. */
export type ExecutionLease = Readonly<{
  runID: string
  threadID: string
  text: string
  fence: number
  ownerID: string
  engine: HarnessEngine
  nativeSessionID: string
  nativeSessionStorage?: 'legacy' | 'session' | undefined
  /** Immutable completed business context for this native binding, not recovery state. */
  initialContext?: ConversationContext | undefined
  /** SQL proves a durable native checkpoint already exists for this identity. */
  requireExisting?: boolean
  deadlineAt: Date
  restoring: boolean
  restoreWorkspace: boolean
  assets?: readonly AssetReference[]
  nativeRef?: NativeSandboxReference
}>

/** Allocation correlation and opaque identity, never SQL write authority or model input. */
export type SandboxAssignment = Readonly<{
  runID: string
  threadID: string
  fence: number
  restoring?: boolean
  nativeRef?: NativeSandboxReference | undefined
}>

/** Assigned asset facts and immutable output identity, never SQL owner authority. */
export type FileAssignment = Pick<ExecutionLease, 'runID' | 'threadID' | 'fence'> &
  Readonly<{ assets?: ExecutionLease['assets'] }>

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

export type ExecutionCompletion = Readonly<{
  sources?: readonly WebSource[] | undefined
  text: string
  assets?: readonly AssetReference[]
}>

export type NativeRequestIdentity = Pick<
  ExecutionLease,
  'engine' | 'threadID' | 'nativeSessionID' | 'nativeSessionStorage' | 'runID' | 'requireExisting'
>

/** Native SDKs own their state and loop. Product supervision never transports a transcript. */
export interface AgentHarness {
  /** Read a known final receipt without generation, tools, or old authority. */
  completed?: (identity: NativeRequestIdentity) => Promise<ExecutionCompletion | undefined>
  run: (
    request: Readonly<{
      engine: HarnessEngine
      threadID: string
      nativeSessionID: string
      nativeSessionStorage?: 'legacy' | 'session' | undefined
      initialContext?: ConversationContext | undefined
      requireExisting?: boolean
      runID: string
      text: string
      tools: SandboxTools
      signal: AbortSignal
      fileTools?: FileTools
      /** Must authorize and reserve spending before the actual provider request. */
      beforeModel: () => Promise<void>
      /** Acknowledge effects only after the adapter's native checkpoint is durable. */
      checkpoint: () => Promise<void>
      onText: (delta: string) => void
    }>,
  ) => Promise<ExecutionCompletion>
}

export type ExecutionFailure = 'execution-error' | 'interrupted'

export type SpendingDecision = 'allowed' | 'cancel' | 'lost' | 'recovery-required' | 'limit'

/** Confirmed local admission failure: the capability did not dispatch remote IO. */
export class CapabilityRejectedError extends Error {}

/** Native history must be restored by an operator, never recreated or replayed. */
export class NativeStateLostError extends Error {
  constructor() {
    super('Native state lost; restore the assigned native session before continuing')
    this.name = 'NativeStateLostError'
  }
}

export interface ExecutionWrites {
  beginWorkspaceTransition: (lease: ExecutionLease) => Promise<boolean>
  settleWorkspaceTransition: (lease: ExecutionLease) => Promise<boolean>
  reserveModel: (lease: ExecutionLease) => Promise<SpendingDecision>
  beginEffect: (lease: ExecutionLease) => Promise<SpendingDecision>
  /** Remove only a proven no-dispatch marker, never refund unknown spending. */
  rejectEffect: (lease: ExecutionLease) => Promise<boolean>
  checkpoint: (lease: ExecutionLease) => Promise<boolean>
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

/** Per-run asset authority; native harness tools wrap it, execution commits its result. */
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
}

export type ExecuteRunDependencies = Readonly<{
  writes: ExecutionWrites
  /** Synchronous worker fail-stop notification, before any SQL ownership release. */
  onNativeUnsettled?: (error: NativeOwnerUnsettledError) => void
  fileTools?: (
    assignment: FileAssignment,
    sandbox: SandboxFiles,
    stopSpending: () => void,
    beforePut: () => Promise<void | (() => Promise<void>)>,
  ) => FileTools
  harness: AgentHarness
  /** The assigned allocator owns connection settings and awaits failed-allocation cleanup. */
  openSandbox: (assignment: SandboxAssignment, signal: AbortSignal) => Promise<SandboxSessionPort>
}>

export type ExecuteRunOptions = Readonly<{
  leaseMs: number
  pollMs: number
  runTimeoutMs?: number
  /** Worker shutdown, not the database's cancellation authority. */
  signal: AbortSignal
}>

export type ExecutionOutcome = 'completed' | 'cancelled' | 'failed' | 'lost'

/** The owned Native SDK may still write history. Stop this process before releasing ownership. */
export class NativeOwnerUnsettledError extends Error {
  constructor(cause: unknown) {
    super('Native owner settlement is unknown', { cause })
    this.name = 'NativeOwnerUnsettledError'
  }
}
