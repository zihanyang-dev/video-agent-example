import { useEffect, useState } from 'react'
import { downloadAsset } from '@vid/contract/client'
import type { PublicAsset } from '@vid/contract/types'
import { apiForUser } from '../http'

export async function assetFileURL(assetID: string) {
  // Build through the generated operation, without fetching file bytes. The
  // real anchor requests the authenticated attachment endpoint on user click.
  const receipt = await downloadAsset({
    client: apiForUser(),
    path: { assetID },
    fetch: Object.assign(async () => new Response(null, { status: 204 }), {
      preconnect: globalThis.fetch.preconnect,
    }),
    parseAs: 'stream',
    throwOnError: true,
  })
  return receipt.request.url
}

export function AssetLinks({ assets }: { assets: readonly PublicAsset[] }) {
  return (
    <ul>
      {assets.map((asset) => (
        <AssetLink key={asset.assetID} asset={asset} />
      ))}
    </ul>
  )
}

function AssetLink({ asset }: { asset: PublicAsset }) {
  const [href, setHref] = useState('')
  useEffect(() => {
    let isCurrent = true
    void assetFileURL(asset.assetID).then((url) => {
      if (isCurrent) setHref(url)
    })
    return () => {
      isCurrent = false
    }
  }, [asset.assetID])
  return (
    <li>
      {href ? (
        <a href={href} download={asset.name}>
          {asset.name}
        </a>
      ) : (
        asset.name
      )}{' '}
      ({asset.mimeType}, {asset.byteLength} bytes)
    </li>
  )
}
