import type { ArtifactDraft } from '../../domain/progress'
import type { Sandbox } from './sandbox'

export type Workspace = {
  restore: (sandbox: Sandbox, prefix: string | null) => Promise<void>
  skills: (sandbox: Sandbox) => Promise<void>
  /** Returns a new immutable version; a failed upload must not damage the prior checkpoint. */
  save: (sandbox: Sandbox, turnID: string) => Promise<string>
  /** Uploads before announcing an artifact, returning a durable key rather than an expiring URL. */
  publish: (sandbox: Sandbox, artifact: ArtifactDraft, turnID: string) => Promise<string>
}
