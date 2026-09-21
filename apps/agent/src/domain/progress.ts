export type TextProgress =
  | {
      kind: 'text-start' | 'text-end'
      messageID: string
      channel: 'assistant' | 'reasoning'
    }
  | {
      kind: 'text-delta'
      messageID: string
      channel: 'assistant' | 'reasoning'
      delta: string
    }

export type ActivityProgress =
  | {
      kind: 'plan'
      messageID: string
      items: { label: string; state: 'todo' | 'doing' | 'done' | 'skipped' }[]
    }
  | {
      kind: 'step'
      messageID: string
      label: string
      state: 'running' | 'done' | 'failed'
      detail?: string | undefined
    }
  | {
      kind: 'ask'
      messageID: string
      question: string
      options: string[]
      answer: string | null
    }

export type ArtifactDraft = {
  kind: 'artifact'
  messageID: string
  path: string
  role: 'preview' | 'final'
}

/** Artifact paths are local observations until the workspace has published their bytes. */
export type Observation = TextProgress | ActivityProgress | ArtifactDraft

export type Progress =
  | TextProgress
  | ActivityProgress
  | {
      kind: 'artifact'
      messageID: string
      key: string
      role: 'preview' | 'final'
    }
  | { kind: 'started' }
  | { kind: 'finished'; outcome: Outcome; reason: string | null }

export type Outcome = 'succeeded' | 'failed' | 'cancelled' | 'interrupted'
