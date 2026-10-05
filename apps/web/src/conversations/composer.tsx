import { useState, useEffect, useRef, type FormEvent } from 'react'
import { ChatAssets } from '../assets/chat-assets'
import type { ThreadScope } from './queries'
import { useMessageSubmission } from './use-message-submission'

export type ComposerProps = {
  scope: ThreadScope
  canSend: boolean
}

// This interaction owns both editable parts of a draft and its single recovery
// surface. The submission hook owns only durable intent and server acceptance.
export function Composer({ scope, canSend: hasNoActiveRuns }: ComposerProps) {
  const submission = useMessageSubmission(scope)
  const initialDraft = submission.pending ?? { text: '', assetIDs: [] }
  const [prompt, setPrompt] = useState(initialDraft.text)
  const [selected, setSelected] = useState(initialDraft.assetIDs)
  const [error, setError] = useState(submission.error)
  const isMounted = useRef(true)
  useEffect(() => {
    isMounted.current = true
    return () => {
      isMounted.current = false
    }
  }, [])
  const canSend =
    hasNoActiveRuns && !submission.hasPending && !submission.isBusy
  const finish = (recovery: string) => {
    if (!isMounted.current) return
    setError(recovery)
    if (recovery) return
    setPrompt('')
    setSelected([])
  }
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canSend || (!prompt.trim() && selected.length === 0)) return
    setError('')
    void submission.send(prompt, selected).then(finish)
  }
  const retryMessage = () => {
    setError('')
    void submission.retry().then(finish)
  }

  return (
    <>
      <ChatAssets
        scope={scope}
        canSelect={canSend}
        selected={selected}
        select={setSelected}
        archived={false}
      />
      <form onSubmit={submit}>
        <label htmlFor="prompt">Describe your video</label>
        <textarea
          id="prompt"
          rows={3}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          disabled={!canSend}
          required={selected.length === 0}
          maxLength={32768}
          placeholder="A quiet sunrise over the ocean, warm light, slow camera movement…"
        />
        <div className="composer-footer">
          <span>
            Attach completed Chat files. Retries preserve the original message
            and attachments.
          </span>
          {submission.hasPending ? (
            <button
              className="primary"
              type="button"
              // A lost receipt may already have created an active run. Frozen
              // replay recovers that receipt; only a new message is gated above.
              disabled={submission.isBusy || !!submission.error}
              onClick={retryMessage}
            >
              Retry same message
            </button>
          ) : (
            <button className="primary" type="submit" disabled={!canSend}>
              Send message ↗
            </button>
          )}
        </div>
        {error && <p role="alert">{error}</p>}
      </form>
    </>
  )
}
