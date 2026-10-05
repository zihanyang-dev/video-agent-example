import { Type, type ImageContent } from '@earendil-works/pi-ai'
import { defineTool } from '@earendil-works/pi-coding-agent'
import type { FileTools } from '../execute-run'

export function fileToolDefinitions(
  files: FileTools,
  signal: AbortSignal,
  supportsImages: boolean,
) {
  return [
    defineTool({
      name: 'import_file',
      label: 'Import file',
      description:
        'Import an assigned asset to a guest path you choose. Image understanding requires supported model input; audio/video require tools.',
      parameters: Type.Object({ assetID: Type.String(), path: Type.String() }),
      async execute(_id, { assetID, path }, sdkSignal) {
        const file = await files.importFile({
          assetID,
          path,
          signal: sdkSignal ?? signal,
        })
        const image: ImageContent = {
          type: 'image',
          data: Buffer.from(file.bytes).toString('base64'),
          mimeType: file.mimeType,
        }
        return {
          content:
            supportsImages &&
            ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(
              file.mimeType,
            )
              ? [{ type: 'text', text: `Imported to ${path}` }, image]
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
        path: Type.String(),
        name: Type.String(),
        mimeType: Type.String(),
      }),
      async execute(_id, { path, name, mimeType }, sdkSignal) {
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
