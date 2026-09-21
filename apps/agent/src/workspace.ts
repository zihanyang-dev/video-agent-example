/**
 * The thread's files, moved between object storage and a machine that only lives for one
 * turn.
 *
 * Split out of the turn for the same reason as delivery: a turn is about a lifetime, and
 * this is about where bytes live. Everything here is about that and nothing else.
 */
import type { Files } from '@vid/store'
import type { Sandbox } from './sandbox/sandbox'

/**
 * The thread's files, into a machine that has none.
 *
 * This is what makes a conversation feel continuous across a sandbox that only lives for one
 * turn: the agent's notes, its cut list, what it decided about shot three, are files.
 */
export const carryIn = async (files: Files, sandbox: Sandbox, threadID: string): Promise<void> => {
  await copyInto(files, sandbox, workspaceOf(threadID), '')
}

const copyInto = async (
  files: Files,
  sandbox: Sandbox,
  prefix: string,
  into: string,
): Promise<void> => {
  const keys = await files.list(prefix)

  // Directories first, and only the ones actually needed. A file written into a directory
  // that is not there fails, and object storage has no directories to tell us about.
  const wanted = new Set(
    keys
      .map((key) => `${into}${key.slice(prefix.length)}`)
      .map((path) => path.slice(0, path.lastIndexOf('/')))
      .filter((directory) => directory !== ''),
  )
  for (const directory of [...wanted].sort()) {
    await sandbox.mkdir(`${sandbox.roots.sandbox}/${directory}`)
  }

  for (const key of keys) {
    const bytes = await files.get(key)
    await sandbox.writeFile(`${sandbox.roots.sandbox}/${into}${key.slice(prefix.length)}`, bytes)
  }
}

/**
 * Skills, into the same sandbox, and they never come back out.
 *
 * Their truth is a git repository that CI publishes, so a sandbox writing to them would be
 * writing to a copy (architecture.md §7). Carried in beside the thread's own files because
 * that is where the agent looks -- it finds them by reading the directory, not by being
 * handed a list.
 */
export const carrySkills = async (files: Files, sandbox: Sandbox): Promise<void> => {
  await copyInto(files, sandbox, SKILLS_PREFIX, `${SKILLS_DIR}/`)
}

export const carryOut = async (files: Files, sandbox: Sandbox, threadID: string): Promise<void> => {
  const prefix = workspaceOf(threadID)

  for (const path of await sandbox.list()) {
    // Skills came from object storage and are read-only here. Writing them back would make
    // this thread's copy the next turn's source.
    if (path === SKILLS_DIR || path.startsWith(`${SKILLS_DIR}/`)) continue
    const bytes = await sandbox.readFile(`${sandbox.roots.sandbox}/${path}`)
    await files.put(`${prefix}${path}`, bytes)
  }
}

export const workspaceOf = (threadID: string): string => `threads/${threadID}/`

const SKILLS_PREFIX = 'skills/'
const SKILLS_DIR = 'skills'
