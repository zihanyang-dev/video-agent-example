import { createRoot } from 'react-dom/client'
import { App } from './app'
import './app.css'

const mount = document.getElementById('root')
if (mount === null) throw new Error('index.html has no #root')

createRoot(mount).render(<App />)
