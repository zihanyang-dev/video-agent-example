import { observeRun } from '@vid/contract/client'
import { apiForUser } from '../http'

async function* noEvents() {}

// HttpAgent owns AG-UI framing and lifecycle. Ask the generated operation to
// build its endpoint without starting a second SSE reader or copying a path.
export async function runEventsURL(path: { threadID: string; runID: string }) {
  const client = apiForUser()
  let url = ''
  await observeRun({
    path,
    body: undefined,
    client: {
      ...client,
      sse: {
        ...client.sse,
        post: async (options) => {
          url = client.buildUrl({ url: options.url, path: options.path ?? {} })
          return { stream: noEvents() }
        },
      },
    },
  })
  return url
}
