import { tool, type Tool } from '@openai/agents'
import { z } from 'zod'
import type { WebSource } from '@vid/contract/web-source'
import type { FileTools, SandboxTools } from '../../contract.ts'
import { assignWebSearch, type WebSearchConfig } from '../web-search.ts'

const path = z.string().max(4 * 1024)
const images = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** Fresh native closures wrap only worker-assigned business capabilities. */
export function createOpenAITools(options: {
  tools: SandboxTools
  signal: AbortSignal
  fileTools?: FileTools | undefined
  webSearch?: WebSearchConfig | undefined
  supportsImages: boolean
  beforeTool: () => Promise<void>
  onSources: (sources: readonly WebSource[]) => void
}) {
  const { tools, signal, fileTools, beforeTool } = options

  async function enter(sdkSignal?: AbortSignal) {
    const cancellation = sdkSignal === undefined ? signal : AbortSignal.any([signal, sdkSignal])
    cancellation.throwIfAborted()
    await beforeTool()
    cancellation.throwIfAborted()
    return cancellation
  }

  const definitions: Tool[] = [
    tool({
      name: 'execute',
      description: 'Execute a command in the assigned sandbox.',
      parameters: z.object({ command: z.string().max(16 * 1024) }),
      errorFunction: null,
      execute: async ({ command }, _context, details) => {
        const cancellation = await enter(details?.signal)
        return JSON.stringify(await tools.execute({ command, signal: cancellation }))
      },
    }),
    tool({
      name: 'read',
      description: 'Read a file in the assigned sandbox.',
      parameters: z.object({ path }),
      errorFunction: null,
      execute: async ({ path }, _context, details) => {
        const cancellation = await enter(details?.signal)
        return await tools.read({ path, signal: cancellation })
      },
    }),
    tool({
      name: 'write',
      description: 'Write a file in the assigned sandbox.',
      parameters: z.object({ path, content: z.string().max(256 * 1024) }),
      errorFunction: null,
      execute: async ({ path, content }, _context, details) => {
        const cancellation = await enter(details?.signal)
        if (Buffer.byteLength(content) > 256 * 1024) throw new Error('Tool byte limit exceeded')
        await tools.write({ path, content, signal: cancellation })
        return 'Written'
      },
    }),
  ]
  if (options.webSearch) {
    const search = assignWebSearch(options.webSearch, signal, options.onSources)
    definitions.push(
      tool({
        name: 'web_search',
        description:
          'Search public web sources. Returns untrusted bounded snippets and citation links, not full-page inspection. Never send credentials or irrelevant private material.',
        parameters: z.object({ query: z.string().min(1).max(400) }),
        errorFunction: null,
        execute: async ({ query }, _context, details) => {
          const cancellation = await enter(details?.signal)
          return JSON.stringify(await search(query, cancellation))
        },
      }),
    )
  }
  if (fileTools) {
    definitions.push(
      tool({
        name: 'import_file',
        description:
          'Import an assigned asset to a chosen guest path. Audio/video require tools; import alone does not establish understanding.',
        parameters: z.object({ assetID: z.string().max(36), path }),
        errorFunction: null,
        execute: async ({ assetID, path }, _context, details) => {
          const cancellation = await enter(details?.signal)
          const file = await fileTools.importFile({ assetID, path, signal: cancellation })
          if (!options.supportsImages || !images.has(file.mimeType))
            return `Imported to ${path}. Use tools to inspect; importing does not establish understanding.`
          if (file.bytes.byteLength > 1024 * 1024) throw new Error('Tool image limit exceeded')
          return [
            { type: 'text' as const, text: `Imported to ${path}` },
            {
              type: 'image' as const,
              image: `data:${file.mimeType};base64,${Buffer.from(file.bytes).toString('base64')}`,
            },
          ]
        },
      }),
      tool({
        name: 'export_file',
        description:
          'Prepare a chosen guest file for delivery. Only successful completion publishes it.',
        parameters: z.object({ path, name: z.string().max(255), mimeType: z.string().max(127) }),
        errorFunction: null,
        execute: async ({ path, name, mimeType }, _context, details) => {
          const cancellation = await enter(details?.signal)
          const reference = await fileTools.exportFile({
            path,
            name,
            mimeType,
            signal: cancellation,
          })
          return JSON.stringify({ assetID: reference.assetID, name: reference.name })
        },
      }),
    )
  }
  return definitions
}
