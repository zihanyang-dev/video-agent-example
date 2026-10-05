import { useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { errorMessage, HTTPError } from '../http'
import type { ThreadScope } from '../conversations/queries'
import {
  discardUpload,
  freezeUpload,
  readUploads,
  sendUpload,
  type PendingUpload,
} from './pending-uploads'

// One generation owns restore, byte persistence, dispatch, and retry. Detaching
// before persistence finishes keeps the cached bytes but never starts HTTP.
export function useChatUploads(scope: ThreadScope) {
  const client = useQueryClient()
  const generation = useRef(0)
  const [pending, setPending] = useState<PendingUpload[]>([])
  const [error, setError] = useState('')
  const [outcomes, setOutcomes] = useState<
    Record<string, 'accepted' | 'refused'>
  >({})
  const [isDiscarding, setDiscarding] = useState(false)
  const [restoration, setRestoration] = useState<
    'restoring' | 'ready' | 'failed'
  >('restoring')
  const isRestoring = restoration === 'restoring'
  const [isFreezing, setFreezing] = useState(false)
  const restoreUploads = async (current = generation.current) => {
    setRestoration('restoring')
    setError('')
    try {
      const uploads = await readUploads(scope)
      if (current !== generation.current) return
      setPending(uploads)
      setRestoration('ready')
    } catch {
      if (current !== generation.current) return
      setError(
        'Browser file storage is unavailable. Uploads require persistent browser storage.',
      )
      // An unreadable cache is not an empty cache. Keep new IDs blocked until
      // the saved bytes can be recovered; restoration never deletes evidence.
      setRestoration('failed')
    }
  }
  useEffect(() => {
    const current = ++generation.current
    setPending([])
    setOutcomes({})
    setFreezing(false)
    setDiscarding(false)
    void restoreUploads(current)
    return () => {
      generation.current++
    }
  }, [scope.userID, scope.threadID])
  const upload = useMutation({
    meta: { userID: scope.userID },
    mutationFn: (frozen: PendingUpload) => sendUpload(scope, frozen),
  })
  const retryUpload = async (
    frozen: PendingUpload,
    current = generation.current,
  ) => {
    if (current !== generation.current) return
    setError('')
    try {
      const result = await upload.mutateAsync(frozen)
      if (current !== generation.current) return
      void client.invalidateQueries({
        queryKey: ['user', scope.userID, scope.threadID, 'assets'],
      })
      if (result.storageError) {
        setOutcomes((entries) => ({ ...entries, [frozen.assetID]: 'accepted' }))
        setError(result.storageError)
        return
      }
    } catch (failure) {
      if (current === generation.current) {
        // These upload refusals occur before publishUpload/SQL. Other statuses
        // (including 503) cannot prove that the server did not save the asset.
        const refused =
          failure instanceof HTTPError &&
          [400, 413, 415].includes(failure.status)
        setOutcomes((entries) => {
          if (entries[frozen.assetID] === 'accepted') return entries
          const next = { ...entries }
          if (refused) next[frozen.assetID] = 'refused'
          else delete next[frozen.assetID]
          return next
        })
        setError(
          refused
            ? `${errorMessage(failure)} Check Chat history, then explicitly forget this saved upload to choose another file.`
            : `${errorMessage(failure)} Retry preserves the same bytes and file ID. Check Chat history before forgetting this saved upload.`,
        )
      }
      return
    }
    if (current !== generation.current) return
    setPending((entries) =>
      entries.filter((entry) => entry.assetID !== frozen.assetID),
    )
  }
  const forgetUpload = async (frozen: PendingUpload, acknowledged: boolean) => {
    if (
      !acknowledged ||
      isRestoring ||
      isFreezing ||
      isDiscarding ||
      upload.isPending
    )
      return
    const current = generation.current
    setDiscarding(true)
    try {
      await discardUpload(scope, frozen)
    } catch {
      if (current === generation.current) {
        setDiscarding(false)
        setError(
          'Saved upload could not be forgotten in this browser. Check Chat history before trying again.',
        )
      }
      return
    }
    if (current !== generation.current) return
    setPending((entries) =>
      entries.filter((entry) => entry.assetID !== frozen.assetID),
    )
    setDiscarding(false)
    setError('')
  }
  const chooseFile = async (file: File) => {
    if (restoration !== 'ready') return
    const current = generation.current
    setError('')
    setFreezing(true)
    let frozen: PendingUpload
    try {
      frozen = await freezeUpload(scope, file)
    } catch {
      if (current !== generation.current) return
      setFreezing(false)
      setError(
        'File could not be saved in this browser. Free browser storage before uploading.',
      )
      return
    }
    if (current !== generation.current) return
    setPending((entries) => [...entries, frozen])
    // Dispatch synchronously hands busy ownership from persistence to mutation.
    const sending = retryUpload(frozen, current)
    setFreezing(false)
    await sending
  }
  const isBusy = isRestoring || isFreezing || isDiscarding || upload.isPending
  const canChooseFile =
    restoration === 'ready' && !isBusy && pending.length === 0
  return {
    pending,
    outcomes,
    restoration,
    restoreUploads,
    forgetUpload,
    error,
    chooseFile,
    retryUpload,
    isBusy,
    canChooseFile,
    status: isRestoring
      ? 'Restoring saved uploads…'
      : isFreezing && !upload.isPending
        ? 'Saving file for exact retry…'
        : upload.isPending
          ? 'Uploading…'
          : '',
  }
}
