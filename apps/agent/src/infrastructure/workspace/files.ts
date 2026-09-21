import type { Files } from '@vid/object-storage'
import { posix } from 'node:path'
import type { Sandbox } from '../../application/ports/sandbox'
import type { Workspace } from '../../application/ports/workspace'

/**
 * Each save publishes a fresh prefix. PostgreSQL later selects the committed version;
 * interrupted uploads may leave unreferenced objects, but cannot corrupt the old version.
 * Skills are loaded independently so an old checkpoint does not freeze published content.
 */
export const createWorkspace = (files: Files): Workspace => ({
  restore: async (sandbox, prefix) => {
    if (prefix !== null) await copyInto(files, sandbox, prefix, '')
  },

  skills: (sandbox) => copyInto(files, sandbox, 'skills/', 'skills/'),

  save: async (sandbox, turnID) => {
    const prefix = `workspaces/${turnID}/${crypto.randomUUID()}/`

    for (const path of await sandbox.list()) {
      if (path === 'skills' || path.startsWith('skills/')) continue
      await files.put(
        `${prefix}${path}`,
        await sandbox.readFile(`${sandbox.roots.sandbox}/${path}`),
      )
    }

    return prefix
  },

  // A later edit of the same sandbox path must not change an artifact already shown to a user.
  publish: async (sandbox, artifact, turnID) => {
    const path = relativePath(artifact.path)
    const key = `outputs/${turnID}/${crypto.randomUUID()}/${path}`
    await files.put(key, await sandbox.readFile(`${sandbox.roots.sandbox}/${path}`))

    return key
  },
})

const relativePath = (path: string): string => {
  const relative = posix.normalize(path.replace(/^\/work\//, ''))
  if (relative.startsWith('/') || relative === '..' || relative.startsWith('../'))
    throw new Error('artifact is outside the workspace')

  return relative
}

const copyInto = async (
  files: Files,
  sandbox: Sandbox,
  prefix: string,
  into: string,
): Promise<void> => {
  for (const key of await files.list(prefix)) {
    const path = `${sandbox.roots.sandbox}/${into}${key.slice(prefix.length)}`
    await sandbox.mkdir(posix.dirname(path))
    await sandbox.writeFile(path, await files.get(key))
  }
}
