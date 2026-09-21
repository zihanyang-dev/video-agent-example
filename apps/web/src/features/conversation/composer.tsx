/**
 * Where a brief gets typed.
 *
 * Sending stays available while a turn runs, on purpose. A person who sees the first shot
 * land and knows it is wrong should be able to say so immediately rather than wait out the
 * nine minutes it takes to be told about it.
 */
import { useCallback, useState, type FormEvent, type KeyboardEvent } from 'react'

/**
 * Runs one request and says so when it fails.
 *
 * Both buttons go through here because both are requests over a network. Stop did not, and
 * a failure became an unhandled rejection -- which the dev server puts on screen as a
 * full-page error and production swallows entirely. Measured, by pressing stop against a
 * server that did not have the route yet.
 */
const useAttempt = () => {
  const [refused, setRefused] = useState<string | null>(null)

  const attempt = useCallback(
    async (run: () => Promise<void>, whenItFails: string, undo?: () => void): Promise<void> => {
      setRefused(null)
      try {
        await run()
      } catch (error) {
        undo?.()
        setRefused(error instanceof Error ? error.message : whenItFails)
      }
    },
    [],
  )

  return { refused, attempt }
}

export const Composer = ({
  onSend,
  onStop,
  working,
}: {
  onSend: (message: string) => Promise<void>
  onStop: () => Promise<void>
  working: boolean
}) => {
  const [text, setText] = useState('')
  const { refused, attempt } = useAttempt()

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const message = text.trim()
    if (message === '') return

    // Cleared first: if the send fails, the message comes back, and a failure that also ate
    // what someone wrote is two problems.
    setText('')
    await attempt(
      () => onSend(message),
      'that did not send',
      () => setText(message),
    )
  }

  const halt = () => void attempt(onStop, 'could not stop it')

  const maybeSubmit = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends, shift-enter breaks the line. A brief is usually one sentence; when it is
    // not, the person writing three paragraphs is the one who will find the shift key.
    if (event.key === 'Enter' && !event.shiftKey) void submit(event)
  }

  return (
    <form className="composer" onSubmit={(event) => void submit(event)}>
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={maybeSubmit}
        rows={3}
        placeholder={working ? 'Add a note while it works…' : 'Describe the opener you want…'}
        aria-label="What you want made"
      />
      {refused !== null && <p className="refused">{refused}</p>}

      <Actions onStop={halt} working={working} sendable={text.trim() !== ''} />
    </form>
  )
}

/**
 * Stop sits beside send rather than replacing it, because both are true while it works: a
 * person can add a note, and can also decide they have seen enough.
 */
const Actions = ({
  onStop,
  working,
  sendable,
}: {
  onStop: () => void
  working: boolean
  sendable: boolean
}) => (
  <div className="actions">
    {working && (
      <button type="button" className="stop" onClick={onStop}>
        Stop
      </button>
    )}
    <button type="submit" disabled={!sendable}>
      Send
    </button>
  </div>
)
