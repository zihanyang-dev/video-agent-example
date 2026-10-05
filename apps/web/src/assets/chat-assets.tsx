import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import {
  useMutation,
  useQuery,
  useQueryClient,
  queryOptions,
} from '@tanstack/react-query'
import { listAssets } from '@vid/contract/client'
import { apiForUser, errorMessage } from '../http'
import type { ThreadScope } from '../conversations/queries'
import { AssetLinks } from './asset-links'
import {
  freezeUpload,
  readUploads,
  sendUpload,
  type PendingUpload,
} from './pending-uploads'

export function assetsQuery(scope: ThreadScope) {
  return queryOptions({
    queryKey: ['user', scope.userID, scope.threadID, 'assets'],
    queryFn: async ({ signal }) =>
      (
        await listAssets({
          client: apiForUser(scope.userID),
          path: { threadID: scope.threadID },
          signal,
          throwOnError: true,
        })
      ).data,
    refetchInterval: 5_000,
  })
}

export function ChatAssets({
  scope,
  canSelect,
  selected,
  select,
  archived,
}: {
  scope: ThreadScope
  canSelect: boolean
  selected: readonly string[]
  select: (assetIDs: string[]) => void
  archived: boolean
}) {
  const assets = useQuery(assetsQuery(scope))
  const client = useQueryClient()
  const [pending, setPending] = useState<PendingUpload[]>([])
  const [error, setError] = useState('')
  const isMounted = useRef(true)
  useEffect(() => {
    let isCurrent = true
    isMounted.current = true
    void readUploads(scope).then(
      (uploads) => {
        if (isCurrent) setPending(uploads)
      },
      () => {
        if (isCurrent)
          setError(
            'Browser file storage is unavailable. Uploads require persistent browser storage.',
          )
      },
    )
    return () => {
      isCurrent = false
      isMounted.current = false
    }
  }, [scope.userID, scope.threadID])
  const upload = useMutation({
    meta: { userID: scope.userID },
    mutationFn: (frozen: PendingUpload) => sendUpload(scope, frozen),
  })
  const send = (frozen: PendingUpload) =>
    upload.mutate(frozen, {
      onSuccess: () => {
        setPending((entries) =>
          entries.filter((entry) => entry.assetID !== frozen.assetID),
        )
        void client.invalidateQueries(assetsQuery(scope))
      },
    })
  const choose = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setError('')
    void freezeUpload(scope, file).then(
      (frozen) => {
        if (!isMounted.current) return
        setPending((entries) => [...entries, frozen])
        send(frozen)
      },
      () =>
        setError(
          'File could not be saved in this browser. Free browser storage before uploading.',
        ),
    )
  }
  const toggle = (assetID: string) => {
    select(
      selected.includes(assetID)
        ? selected.filter((id) => id !== assetID)
        : [...selected, assetID],
    )
  }
  return (
    <section aria-label="Chat files">
      <h2>Files</h2>
      {assets.isError && <p role="alert">{errorMessage(assets.error)}</p>}
      <AssetLinks assets={assets.data?.assets ?? []} />
      {!archived && (
        <>
          <label>
            Upload file
            <input
              type="file"
              onChange={choose}
              disabled={upload.isPending || !canSelect}
            />
          </label>
          <p className="detail">
            Receiving a video does not imply model understanding. File limits
            are enforced by the server. Keep this browser's data to retain
            unknown upload bytes for exact retry.
          </p>
          {assets.data?.assets.map((asset) => (
            <label key={asset.assetID}>
              <input
                type="checkbox"
                checked={selected.includes(asset.assetID)}
                disabled={
                  !canSelect ||
                  (!selected.includes(asset.assetID) && selected.length >= 16)
                }
                onChange={() => toggle(asset.assetID)}
              />
              Attach {asset.name}
            </label>
          ))}
          {pending.map((frozen) => (
            <div key={frozen.assetID}>
              <span>Upload acceptance unknown: {frozen.name}. </span>
              <button
                disabled={upload.isPending || !canSelect}
                onClick={() => send(frozen)}
              >
                Retry same file
              </button>
            </div>
          ))}
        </>
      )}
      {upload.isPending && <p role="status">Uploading…</p>}
      {upload.isError && (
        <p role="alert">
          {errorMessage(upload.error)} Retry preserves the same bytes and file
          ID.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  )
}
