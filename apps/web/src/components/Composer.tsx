/**
 * Where a brief gets typed.
 *
 * Sending stays available while a turn runs, on purpose. A person who sees the first shot
 * land and knows it is wrong should be able to say so immediately rather than wait out the
 * nine minutes it takes to be told about it.
 */
import { useState, type FormEvent, type KeyboardEvent } from 'react'

export const Composer = ({
  onSend,
  working,
}: {
  onSend: (message: string) => Promise<void>
  working: boolean
}) => {
  const [text, setText] = useState('')
  const [refused, setRefused] = useState<string | null>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const message = text.trim()
    if (message === '') return

    // Cleared first: if the send fails, the message comes back, and a failure that also ate
    // what someone wrote is two problems.
    setText('')
    setRefused(null)
    try {
      await onSend(message)
    } catch (error) {
      setText(message)
      setRefused(error instanceof Error ? error.message : 'that did not send')
    }
  }

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
      <button type="submit" disabled={text.trim() === ''}>
        Send
      </button>
    </form>
  )
}
