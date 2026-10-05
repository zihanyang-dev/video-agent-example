import { useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { updateThread, archiveThread } from '@vid/contract/client'
import { errorMessage, apiForUser, abortHTTP } from '../http'
import { threadQuery, threadsQuery, type ThreadScope } from './queries'

export function ChatSettings({
  scope,
  title,
}: {
  scope: ThreadScope
  title: string
}) {
  return (
    <section aria-label="Chat settings">
      <RenameChat scope={scope} title={title} />
      <ArchiveChat scope={scope} />
    </section>
  )
}

function RenameChat({ scope, title }: { scope: ThreadScope; title: string }) {
  const client = useQueryClient()
  const [editedTitle, setTitle] = useState(title)
  const [intent, setIntent] = useState<string | undefined>(undefined)
  const update = useMutation({
    meta: { userID: scope.userID },
    mutationFn: async (frozenTitle: string) =>
      (
        await updateThread({
          client: apiForUser(scope.userID),
          path: { threadID: scope.threadID },
          body: { title: frozenTitle },
          throwOnError: true,
        })
      ).data,
  })
  const rename = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!editedTitle.trim() || update.isPending) return
    const frozenTitle = intent ?? editedTitle
    setIntent(frozenTitle)
    // Per-call callbacks stop with this observer. An account switch must not
    // repopulate the old user's cache after a slow mutation finishes.
    update.mutate(frozenTitle, {
      onSuccess: (receipt) => {
        client.setQueryData(threadQuery(scope).queryKey, receipt)
        setIntent(undefined)
        void client.invalidateQueries(threadsQuery(scope.userID))
      },
    })
  }
  const edit = (event: React.ChangeEvent<HTMLInputElement>) =>
    setTitle(event.target.value)
  return (
    <form onSubmit={rename}>
      <label>
        Chat title
        <input
          value={editedTitle}
          onChange={edit}
          readOnly={intent !== undefined}
          maxLength={160}
          required
        />
      </label>
      <button disabled={update.isPending}>
        {update.isError ? 'Retry rename' : 'Rename Chat'}
      </button>
      {update.isPending && <p role="status">Saving title…</p>}
      {update.isError && <p role="alert">{errorMessage(update.error)}</p>}
    </form>
  )
}

function ArchiveChat({ scope }: { scope: ThreadScope }) {
  const client = useQueryClient()
  const archive = useMutation({
    meta: { userID: scope.userID },
    mutationFn: async () => {
      await archiveThread({
        client: apiForUser(scope.userID),
        path: { threadID: scope.threadID },
        body: {},
        throwOnError: true,
      })
    },
  })
  const requestArchive = () =>
    archive.mutate(undefined, {
      onSuccess: () => {
        abortHTTP(scope.userID)
        void client.cancelQueries({
          queryKey: ['user', scope.userID, scope.threadID],
        })
        void client.invalidateQueries({ queryKey: ['user', scope.userID] })
      },
    })
  return (
    <>
      <button onClick={requestArchive} disabled={archive.isPending}>
        {archive.isError ? 'Retry archive' : 'Archive Chat'}
      </button>
      {archive.isPending && <p role="status">Requesting archive and stop…</p>}
      {archive.isError && <p role="alert">{errorMessage(archive.error)}</p>}
    </>
  )
}
