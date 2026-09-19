/**
 * Puts the skills in this checkout into object storage, where a turn carries them from.
 *
 * Skills are content, not code: git is the truth, this pushes what git has, and changing one
 * ships without a deploy (architecture.md §7). A turn copies them into its sandbox beside
 * the thread's own files, and the agent finds them by reading the directory.
 */
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createS3Files } from '../src/s3-files'

const SOURCE = new URL('../../../skills/', import.meta.url).pathname
const PREFIX = 'skills/'

const required = (name: string): string => {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`${name} is not set`)
  return value
}

const files = createS3Files({
  bucket: required('OBJECTS_BUCKET'),
  endpoint: required('OBJECTS_ENDPOINT'),
  accessKeyId: required('OBJECTS_ACCESS_KEY'),
  secretAccessKey: required('OBJECTS_SECRET_KEY'),
  region: process.env['OBJECTS_REGION'] ?? 'us-east-1',
})

/** Every file under a directory, as paths relative to it. */
const walk = async (directory: string, prefix = ''): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true })
  const found: string[] = []

  for (const entry of entries) {
    const path = `${prefix}${entry.name}`
    if (entry.isDirectory()) found.push(...(await walk(join(directory, entry.name), `${path}/`)))
    else found.push(path)
  }
  return found
}

/**
 * Name and description out of one SKILL.md's frontmatter.
 *
 * Read here rather than at the start of every turn: what a skill is called only changes
 * when someone publishes, and a turn that re-derived it would be parsing the same bytes
 * hundreds of times for an answer that never moved.
 */
const indexOf = async (directory: string): Promise<SkillEntry | null> => {
  const text = await Bun.file(join(SOURCE, directory, 'SKILL.md')).text()
  const name = /^name:\s*(.+)$/m.exec(text)?.[1]?.trim()
  const description = /^description:\s*(.+)$/m.exec(text)?.[1]?.trim()
  if (name === undefined || description === undefined) return null

  return { name, description, dir: directory }
}

type SkillEntry = { name: string; description: string; dir: string }

const paths = await walk(SOURCE)
for (const path of paths) {
  await files.put(
    `${PREFIX}${path}`,
    new Uint8Array(await Bun.file(join(SOURCE, path)).arrayBuffer()),
  )
}

const directories = [
  ...new Set(paths.filter((path) => path.includes('/')).map((path) => path.split('/')[0]!)),
]
const index = (await Promise.all(directories.map(indexOf))).filter((entry) => entry !== null)
await files.put(`${PREFIX}index.json`, new TextEncoder().encode(JSON.stringify(index, null, 2)))

console.log(`published ${paths.length} files and an index of ${index.length}:`)
for (const entry of index) console.log(`  ${entry.name} — ${entry.description.slice(0, 70)}...`)
