import { expect, test } from 'bun:test'
import type { Files } from '@vid/object-storage'
import { createMemorySandbox } from '../../../../../tests/fixtures/sandbox'
import { createWorkspace } from './files'

const fixture = () => {
  const objects = new Map<string, Uint8Array>()
  const files: Files = {
    list: async (prefix) => [...objects.keys()].filter((key) => key.startsWith(prefix)),
    get: async (key) => {
      const bytes = objects.get(key)
      if (!bytes) throw new Error('missing object')
      return bytes
    },
    put: async (key, bytes) => {
      objects.set(key, bytes)
    },
    downloadUrl: async (key) => `https://objects/${key}`,
  }
  return { workspace: createWorkspace(files), files, objects, sandbox: createMemorySandbox() }
}

test('workspace versions remain immutable and restore only the committed version', async () => {
  const { workspace, sandbox } = fixture()
  await sandbox.writeFile('/work/note.txt', new Uint8Array([1]))
  const first = await workspace.save(sandbox, 'turn')
  await sandbox.writeFile('/work/note.txt', new Uint8Array([2]))
  await sandbox.writeFile('/work/extra.txt', new Uint8Array([3]))
  const second = await workspace.save(sandbox, 'turn')

  expect(first).not.toBe(second)

  const restored = createMemorySandbox()
  await workspace.restore(restored, first)

  expect(await restored.readFile('/work/note.txt')).toEqual(new Uint8Array([1]))
  expect(await restored.list()).toEqual(['note.txt'])
})

test('skills are refreshed from the catalog rather than saved into the workspace', async () => {
  const { workspace, sandbox, files, objects } = fixture()
  await files.put('skills/edit/SKILL.md', new Uint8Array([1]))
  await workspace.skills(sandbox)
  expect(await sandbox.readFile('/work/skills/edit/SKILL.md')).toEqual(new Uint8Array([1]))

  const prefix = await workspace.save(sandbox, 'turn')
  expect([...objects.keys()].filter((key) => key.startsWith(prefix))).toEqual([])
})

test('publishing a revised artifact never overwrites a previously visible version', async () => {
  const { workspace, sandbox, files } = fixture()
  const artifact = {
    kind: 'artifact' as const,
    messageID: 'video',
    path: 'final.mp4',
    role: 'final' as const,
  }

  await sandbox.writeFile('/work/final.mp4', new Uint8Array([1]))
  const first = await workspace.publish(sandbox, artifact, 'turn')

  await sandbox.writeFile('/work/final.mp4', new Uint8Array([2]))
  const second = await workspace.publish(sandbox, artifact, 'turn')

  expect(first).not.toBe(second)
  expect(await files.get(first)).toEqual(new Uint8Array([1]))
  expect(await files.get(second)).toEqual(new Uint8Array([2]))
})

test('an artifact announced outside the workspace is rejected before publication', async () => {
  const { workspace, sandbox, objects } = fixture()
  await expect(
    workspace.publish(
      sandbox,
      { kind: 'artifact', messageID: 'video', path: '../../secret', role: 'final' },
      'turn',
    ),
  ).rejects.toThrow('outside the workspace')
  expect(objects.size).toBe(0)
})
