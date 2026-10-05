import { useState, type FormEvent } from 'react'
import { useMutation } from '@tanstack/react-query'
import { threadCreationSchema } from '@vid/contract/http'
import { errorMessage } from '../http'
import { pendingIntents, pendingIntentRecoveryMessage } from './pending-intents'

export type ChatCreationIntent = ReturnType<typeof threadCreationSchema.parse>
export function ChatCreation({
  create,
  userID,
}: {
  userID: string
  create: (creation: ChatCreationIntent) => Promise<void>
}) {
  const intents = pendingIntents(userID)
  const [restored] = useState(() => {
    try {
      return { pending: intents.readCreation(), error: '' }
    } catch {
      return { pending: undefined, error: pendingIntentRecoveryMessage }
    }
  })
  const [pending, setPending] = useState(restored.pending)
  const [title, setTitle] = useState(pending?.title ?? '')
  const [storageError, setStorageError] = useState(restored.error)
  const mutation = useMutation({
    meta: { userID },
    mutationFn: create,
  })
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!title.trim() || mutation.isPending || restored.error) return
    // Freeze ID and title before I/O: lost receipts may have already committed.
    // A retry cannot silently change the command and create a second object.
    try {
      const intent = intents.creation(title)
      setPending(intent)
      mutation.mutate(intent, {
        onSuccess: () => {
          intents.acceptCreation()
          setPending(undefined)
          setTitle('')
        },
      })
    } catch {
      setStorageError(
        'Chat intent could not be saved. Enable browser storage before creating.',
      )
    }
  }
  const edit = (event: React.ChangeEvent<HTMLInputElement>) =>
    setTitle(event.target.value)
  return (
    <form onSubmit={submit}>
      <label>
        Create Chat
        <input
          value={title}
          onChange={edit}
          required
          maxLength={160}
          readOnly={!!pending || !!restored.error}
        />
      </label>
      <button disabled={mutation.isPending || !!restored.error} type="submit">
        {mutation.isError ? 'Retry create Chat' : 'Create Chat'}
      </button>
      {storageError && <p role="alert">{storageError}</p>}
      {mutation.isPending && <p role="status">Saving…</p>}
      {mutation.isError && (
        <p role="alert">
          {errorMessage(mutation.error)} Retry keeps the same ID and title.
        </p>
      )}
    </form>
  )
}
