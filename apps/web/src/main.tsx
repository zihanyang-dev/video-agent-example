import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { Identity, createWebQueryClient } from './identity/session'

const root = document.getElementById('root')
if (!root) throw new Error('Missing application root')
const client = createWebQueryClient()
createRoot(root).render(
  <QueryClientProvider client={client}>
    <Identity />
  </QueryClientProvider>,
)
