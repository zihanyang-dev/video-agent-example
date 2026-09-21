import { work } from './bootstrap'
import { readEnv } from './env'

await work(readEnv())
