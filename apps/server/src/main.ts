import { serve } from './bootstrap'
import { readEnv } from './env'

await serve(readEnv())
