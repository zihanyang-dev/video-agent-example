import { Type } from '@earendil-works/pi-ai'
import { defineTool } from '@earendil-works/pi-coding-agent'
import type { FileTools } from '../execute-run'

export function fileToolDefinitions(
  files: FileTools,
  signal: AbortSignal,
  supportsImages: boolean,
  onLimit: () => never,
) {
  return [
    defineTool({
      name: 'import_file',
      label: 'Import file',
      description:
        'Import an assigned asset to a guest path you choose. Image understanding requires supported model input; audio/video require tools.',
      parameters: Type.Object({
        assetID: Type.String({ maxLength: 36 }),
        path: Type.String({ maxLength: 4 * 1024 }),
      }),
      async execute(_id, { assetID, path }, sdkSignal) {
        signal.throwIfAborted()
        sdkSignal?.throwIfAborted()
        const file = await files.importFile({
          assetID,
          path,
          signal: sdkSignal ?? signal,
        })
        const image =
          supportsImages &&
          ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(
            file.mimeType,
          )
        const bytes = image ? file.bytes : undefined
        if (bytes !== undefined && bytes.byteLength > 1024 * 1024) onLimit()
        return {
          content:
            bytes !== undefined
              ? [
                  { type: 'text', text: `Imported to ${path}` },
                  {
                    type: 'image',
                    data: Buffer.from(bytes).toString('base64'),
                    mimeType: file.mimeType,
                  },
                ]
              : [
                  {
                    type: 'text',
                    text: `Imported to ${path}. Use tools to inspect; importing does not establish understanding.`,
                  },
                ],
          details: {},
        }
      },
    }),
    defineTool({
      name: 'export_file',
      label: 'Export file',
      description:
        'Prepare a chosen guest file for delivery. Only a successfully completed run publishes it.',
      parameters: Type.Object({
        path: Type.String({ maxLength: 4 * 1024 }),
        name: Type.String({ maxLength: 255 }),
        mimeType: Type.String({ maxLength: 127 }),
      }),
      async execute(_id, { path, name, mimeType }, sdkSignal) {
        signal.throwIfAborted()
        sdkSignal?.throwIfAborted()
        const reference = await files.exportFile({
          path,
          name,
          mimeType,
          signal: sdkSignal ?? signal,
        })
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                assetID: reference.assetID,
                name: reference.name,
              }),
            },
          ],
          details: {},
        }
      },
    }),
  ]
}
