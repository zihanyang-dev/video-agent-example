import { Type } from '@earendil-works/pi-ai'
import {
  defineTool,
  type AgentToolResult,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent'
import type { WebSource } from '@vid/contract/web-source'
import type { FileTools, SandboxTools } from '../../contract.ts'
import { assignWebSearch, type WebSearchConfig } from '../web-search.ts'

type ToolOptions = Readonly<{
  tools: SandboxTools
  signal: AbortSignal
  fileTools?: FileTools | undefined
  webSearch?: WebSearchConfig | undefined
  supportsImages: boolean
  onLimit: () => never
  onSources?: (sources: readonly WebSource[]) => void
}>

const pathSchema = Type.String({ maxLength: 4 * 1024 })
const imageMimeTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

function toolSignal(owner: AbortSignal, sdk?: AbortSignal) {
  const signal = sdk === undefined ? owner : AbortSignal.any([owner, sdk])
  signal.throwIfAborted()
  return signal
}

function textResult(text: string): AgentToolResult<unknown> {
  return { content: [{ type: 'text', text }], details: {} }
}

function importedFileResult(
  file: Awaited<ReturnType<FileTools['importFile']>>,
  path: string,
  supportsImages: boolean,
  onLimit: () => never,
): AgentToolResult<unknown> {
  if (!supportsImages || !imageMimeTypes.has(file.mimeType))
    return textResult(
      `Imported to ${path}. Use tools to inspect; importing does not establish understanding.`,
    )
  const bytes = file.bytes
  if (bytes.byteLength > 1024 * 1024) onLimit()
  return {
    content: [
      { type: 'text', text: `Imported to ${path}` },
      { type: 'image', data: Buffer.from(bytes).toString('base64'), mimeType: file.mimeType },
    ],
    details: {},
  }
}

/** Native definitions only; authorization, asset IO and search policy stay in capabilities. */
export function createToolDefinitions({
  tools,
  signal,
  fileTools,
  webSearch,
  supportsImages,
  onLimit,
  onSources,
}: ToolOptions) {
  const search = webSearch === undefined ? undefined : assignWebSearch(webSearch, signal, onSources)

  const definitions: ToolDefinition[] = [
    defineTool({
      name: 'execute',
      label: 'Execute',
      description: 'Execute a command in the assigned sandbox.',
      parameters: Type.Object({ command: Type.String({ maxLength: 16 * 1024 }) }),
      async execute(_id, { command }, sdkSignal) {
        const result = await tools.execute({ command, signal: toolSignal(signal, sdkSignal) })
        return textResult(JSON.stringify(result))
      },
    }),
    defineTool({
      name: 'read',
      label: 'Read',
      description: 'Read a file in the assigned sandbox.',
      parameters: Type.Object({ path: pathSchema }),
      async execute(_id, { path }, sdkSignal) {
        return textResult(await tools.read({ path, signal: toolSignal(signal, sdkSignal) }))
      },
    }),
    defineTool({
      name: 'write',
      label: 'Write',
      description: 'Write a file in the assigned sandbox.',
      parameters: Type.Object({
        path: pathSchema,
        content: Type.String({ maxLength: 256 * 1024 }),
      }),
      async execute(_id, { path, content }, sdkSignal) {
        const cancellation = toolSignal(signal, sdkSignal)
        if (Buffer.byteLength(content) > 256 * 1024) onLimit()
        await tools.write({ path, content, signal: cancellation })
        return textResult('Written')
      },
    }),
  ]

  if (search !== undefined) {
    definitions.push(
      defineTool({
        name: 'web_search',
        label: 'Web search',
        description:
          'Search public web sources. Returns untrusted bounded snippets and citation links, not full-page inspection. Never send credentials or irrelevant private material.',
        parameters: Type.Object(
          { query: Type.String({ minLength: 1, maxLength: 400 }) },
          { additionalProperties: false },
        ),
        async execute(_id, { query }, sdkSignal) {
          return textResult(JSON.stringify(await search(query, sdkSignal)))
        },
      }),
    )
  }

  if (fileTools !== undefined) {
    definitions.push(
      defineTool({
        name: 'import_file',
        label: 'Import file',
        description:
          'Import an assigned asset to a guest path you choose. Image understanding requires supported model input; audio/video require tools.',
        parameters: Type.Object({ assetID: Type.String({ maxLength: 36 }), path: pathSchema }),
        async execute(_id, { assetID, path }, sdkSignal) {
          const file = await fileTools.importFile({
            assetID,
            path,
            signal: toolSignal(signal, sdkSignal),
          })
          return importedFileResult(file, path, supportsImages, onLimit)
        },
      }),
      defineTool({
        name: 'export_file',
        label: 'Export file',
        description:
          'Prepare a chosen guest file for delivery. Only a successfully completed run publishes it.',
        parameters: Type.Object({
          path: pathSchema,
          name: Type.String({ maxLength: 255 }),
          mimeType: Type.String({ maxLength: 127 }),
        }),
        async execute(_id, { path, name, mimeType }, sdkSignal) {
          const reference = await fileTools.exportFile({
            path,
            name,
            mimeType,
            signal: toolSignal(signal, sdkSignal),
          })
          return textResult(JSON.stringify({ assetID: reference.assetID, name: reference.name }))
        },
      }),
    )
  }
  return definitions
}
