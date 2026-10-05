import { useState, type ChangeEvent } from 'react'
import { useQuery, queryOptions } from '@tanstack/react-query'
import { listAssets } from '@vid/contract/client'
import { apiForUser, errorMessage } from '../http'
import type { ThreadScope } from '../conversations/queries'
import { AssetLinks } from './asset-links'
import { useChatUploads } from './use-chat-uploads'

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
  const upload = useChatUploads(scope)
  const choose = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file) void upload.chooseFile(file)
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
              disabled={!upload.canChooseFile || !canSelect}
            />
          </label>
          {upload.restoration === 'failed' && (
            <button
              disabled={upload.isBusy}
              onClick={() => {
                void upload.restoreUploads()
              }}
            >
              Retry restoring saved uploads
            </button>
          )}
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
          {upload.pending.map((frozen) => (
            <UploadRecovery
              key={`${scope.userID}:${scope.threadID}:${frozen.assetID}`}
              name={frozen.name}
              outcome={upload.outcomes[frozen.assetID]}
              disabled={upload.isBusy || !canSelect}
              retry={() => {
                void upload.retryUpload(frozen)
              }}
              forget={(acknowledged) => {
                void upload.forgetUpload(frozen, acknowledged)
              }}
            />
          ))}
        </>
      )}
      {upload.status && <p role="status">{upload.status}</p>}
      {upload.error && <p role="alert">{upload.error}</p>}
    </section>
  )
}

export function UploadRecovery({
  name,
  outcome,
  disabled,
  retry,
  forget,
}: {
  name: string
  outcome: 'accepted' | 'refused' | undefined
  disabled: boolean
  retry: () => void
  forget: (acknowledged: boolean) => void
}) {
  const [acknowledged, setAcknowledged] = useState(false)
  return (
    <div>
      <span>
        {outcome === 'accepted'
          ? 'File accepted; saved upload retained'
          : outcome === 'refused'
            ? 'File refused by server'
            : 'Upload acceptance unknown'}
        : {name}.{' '}
      </span>
      <button disabled={disabled} onClick={retry}>
        Retry same file
      </button>
      <p className="detail">
        Check Chat history before forgetting this saved upload.
      </p>
      <label>
        <input
          type="checkbox"
          checked={acknowledged}
          disabled={disabled}
          onChange={(event) => setAcknowledged(event.target.checked)}
        />
        I checked Chat history. Forgetting an uncertain saved upload loses exact
        retry; it may already be saved on the server.
      </label>
      <button
        disabled={disabled || !acknowledged}
        onClick={() => forget(acknowledged)}
      >
        Forget saved upload locally and choose another file
      </button>
      <p className="detail">
        This only removes browser retry bytes, not server files.
      </p>
    </div>
  )
}
