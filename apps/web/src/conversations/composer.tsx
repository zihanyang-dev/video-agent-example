import {
  useState,
  useEffect,
  useRef,
  type FormEvent,
  type ChangeEvent,
} from 'react'
import { errorMessage } from '../http'

export type ComposerProps = {
  canSend: boolean
  hasAssets?: boolean
  isBusy: boolean
  hasPending: boolean
  send: (text: string) => Promise<void>
  retry: () => Promise<void>
}

export function Composer(props: ComposerProps) {
  const { canSend, isBusy, hasPending, send, retry } = props
  const [prompt, setPrompt] = useState('')
  const [error, setError] = useState('')
  const isMounted = useRef(true)
  useEffect(() => {
    isMounted.current = true
    return () => {
      isMounted.current = false
    }
  }, [])
  const clearAcceptedPrompt = () => {
    if (isMounted.current) {
      setPrompt('')
      setError('')
    }
  }
  const reportFailure = (failure: unknown) => {
    if (isMounted.current) setError(errorMessage(failure))
  }
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canSend || (!prompt.trim() && !props.hasAssets)) return
    setError('')
    void send(prompt).then(clearAcceptedPrompt, reportFailure)
  }
  const retryMessage = () => {
    setError('')
    void retry().then(clearAcceptedPrompt, reportFailure)
  }
  const editPrompt = (event: ChangeEvent<HTMLTextAreaElement>) =>
    setPrompt(event.target.value)

  return (
    <form onSubmit={submit}>
      <label htmlFor="prompt">Describe your video</label>
      <textarea
        id="prompt"
        rows={3}
        value={prompt}
        onChange={editPrompt}
        disabled={!canSend}
        required={!props.hasAssets}
        maxLength={32768}
        placeholder="A quiet sunrise over the ocean, warm light, slow camera movement…"
      />
      <ComposerActions
        canSend={canSend}
        isBusy={isBusy}
        hasPending={hasPending}
        retryMessage={retryMessage}
      />
      {error && <p role="alert">{error}</p>}
    </form>
  )
}

function ComposerActions({
  canSend,
  isBusy,
  hasPending,
  retryMessage,
}: {
  canSend: boolean
  isBusy: boolean
  hasPending: boolean
  retryMessage: () => void
}) {
  return (
    <div className="composer-footer">
      <span>
        Attach completed Chat files. Retries preserve the original message and
        attachments.
      </span>
      {hasPending ? (
        <button
          className="primary"
          type="button"
          disabled={isBusy}
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
  )
}
