import { expect, spyOn, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CURRENT_SESSION_VERSION, SessionManager } from '@earendil-works/pi-coding-agent'
import { checkpointPiSession, openPiSession, readCompletedPiRequest } from './session'

const corruptions = [
  { name: 'self-cycle', entries: [{ id: 'a', parentId: 'a' }] },
  {
    name: 'multi-cycle',
    entries: [
      { id: 'a', parentId: 'b' },
      { id: 'b', parentId: 'a' },
    ],
  },
  {
    name: 'inactive cycle',
    entries: [
      { id: 'a', parentId: 'a' },
      { id: 'leaf', parentId: null },
    ],
  },
  {
    name: 'duplicate ID',
    entries: [
      { id: 'a', parentId: null },
      { id: 'a', parentId: null },
    ],
  },
  { name: 'orphan', entries: [{ id: 'a', parentId: 'missing' }] },
  { name: 'header parent', entries: [{ id: 'a', parentId: 'header' }] },
  { name: 'missing parent', entries: [{ id: 'a' }] },
  { name: 'numeric parent', entries: [{ id: 'a', parentId: 1 }] },
  { name: 'empty parent', entries: [{ id: 'a', parentId: '' }] },
  { name: 'missing ID', entries: [{ parentId: null }] },
  { name: 'empty ID', entries: [{ id: '', parentId: null }] },
  { name: 'duplicate header', entries: [{ type: 'session', id: 'other', parentId: null }] },
]

for (const { name, entries } of corruptions) {
  test(`rejects ${name} before SDK opening/traversal and without changing native bytes`, async () => {
    const statePath = await mkdtemp(join(tmpdir(), 'pi-lineage-'))
    const threadID = crypto.randomUUID()
    const nativeSessionID = crypto.randomUUID()
    const directory = join(statePath, 'pi', threadID, nativeSessionID)
    const path = join(directory, 'fixture.jsonl')
    // The public traversal veto makes RED safe: the unguarded loader reaches this
    // instead of entering the SDK's unbounded parent walk. No synthetic SDK frames.
    const traversal = spyOn(SessionManager.prototype, 'getBranch').mockImplementation(() => {
      throw new Error('Unsafe native branch traversal reached')
    })
    const opening = spyOn(SessionManager, 'open')
    try {
      await mkdir(directory, { recursive: true })
      const bytes =
        [
          {
            type: 'session',
            version: CURRENT_SESSION_VERSION,
            id: nativeSessionID,
            timestamp: new Date().toISOString(),
            cwd: '/',
          },
          ...entries.map((entry) => ({
            type: 'custom',
            timestamp: new Date().toISOString(),
            customType: 'fixture',
            data: {},
            ...entry,
            ...('parentId' in entry && entry.parentId === 'header'
              ? { parentId: nativeSessionID }
              : {}),
          })),
        ]
          .map((entry) => JSON.stringify(entry))
          .join('\n') + '\n'
      await writeFile(path, bytes)
      expect(() =>
        readCompletedPiRequest(statePath, {
          engine: 'pi',
          threadID,
          nativeSessionID,
          runID: crypto.randomUUID(),
          requireExisting: true,
          nativeSessionStorage: 'session',
        }),
      ).toThrow('Invalid native Pi session')
      await Promise.resolve(
        expect(
          openPiSession(statePath, threadID, nativeSessionID, {
            requireExisting: true,
            storage: 'session',
          }),
        ).rejects.toThrow('Invalid native Pi session'),
      )
      expect(opening).not.toHaveBeenCalled()
      expect(traversal).not.toHaveBeenCalled()
      expect(await readFile(path, 'utf8')).toBe(bytes)
    } finally {
      opening.mockRestore()
      traversal.mockRestore()
      await rm(statePath, { recursive: true, force: true })
    }
  })
}

test('preserves SDK-produced branching, compaction, multiple roots and parent-session headers', async () => {
  const statePath = await mkdtemp(join(tmpdir(), 'pi-lineage-valid-'))
  const threadID = crypto.randomUUID()
  const nativeSessionID = crypto.randomUUID()
  const directory = join(statePath, 'pi', threadID, nativeSessionID)
  const runID = crypto.randomUUID()
  try {
    const manager = SessionManager.create('/', directory, {
      id: nativeSessionID,
      parentSession: '/fixture-parent.jsonl',
    })
    const root = manager.appendMessage({ role: 'user', content: 'Original input', timestamp: 1 })
    manager.appendCustomEntry('abandoned', { retained: true })
    manager.branch(root)
    manager.branchWithSummary(root, 'Abandoned branch summary')
    const kept = manager.appendMessage({ role: 'user', content: 'Kept input', timestamp: 2 })
    manager.appendCompaction('Compacted history', kept, 100)
    manager.appendCustomEntry('platform-completed', { runID, result: { text: 'Compacted final' } })
    await checkpointPiSession(manager)
    const path = manager.getSessionFile()
    if (path === undefined) throw new Error('Expected native file')
    const bytes = await readFile(path, 'utf8')
    const reopened = await openPiSession(statePath, threadID, nativeSessionID, {
      requireExisting: true,
      storage: 'session',
    })
    expect(reopened.getBranch().map((entry) => entry.type)).toEqual([
      'message',
      'branch_summary',
      'message',
      'compaction',
      'custom',
    ])
    expect(JSON.stringify(reopened.buildSessionContext().messages)).toContain('Compacted history')
    expect(
      readCompletedPiRequest(statePath, {
        engine: 'pi',
        threadID,
        nativeSessionID,
        runID,
        nativeSessionStorage: 'session',
      }),
    ).toEqual({ text: 'Compacted final' })
    expect(await readFile(path, 'utf8')).toBe(bytes)
    reopened.resetLeaf()
    reopened.appendMessage({ role: 'user', content: 'Second root', timestamp: 3 })
    reopened.appendCompaction('Retain none', null, 100)
    await checkpointPiSession(reopened)
    const multipleRoots = await openPiSession(statePath, threadID, nativeSessionID, {
      storage: 'session',
    })
    expect(multipleRoots.getBranch().map((entry) => entry.type)).toEqual(['message', 'compaction'])
    expect(multipleRoots.getEntries().length).toBe(8)
  } finally {
    await rm(statePath, { recursive: true, force: true })
  }
})

test('loads a long native lineage without recursive or repeated ancestor walks', async () => {
  const statePath = await mkdtemp(join(tmpdir(), 'pi-lineage-long-'))
  const threadID = crypto.randomUUID()
  const nativeSessionID = crypto.randomUUID()
  const directory = join(statePath, 'pi', threadID, nativeSessionID)
  try {
    const manager = SessionManager.create('/', directory, { id: nativeSessionID })
    for (let i = 0; i < 30000; i++) manager.appendCustomEntry('fixture', { index: i })
    // Public message append flushes the accumulated SDK entries to disk.
    manager.appendMessage({ role: 'user', content: 'Flush history', timestamp: 1 })
    await checkpointPiSession(manager)
    const reopened = await openPiSession(statePath, threadID, nativeSessionID, {
      storage: 'session',
    })
    expect(reopened.getBranch()).toHaveLength(30001)
  } finally {
    await rm(statePath, { recursive: true, force: true })
  }
}, 10000)

for (const version of [1, 2]) {
  test(`preserves public SDK migration of version ${version} sessions`, async () => {
    const statePath = await mkdtemp(join(tmpdir(), 'pi-lineage-version-'))
    const threadID = crypto.randomUUID()
    const nativeSessionID = crypto.randomUUID()
    const directory = join(statePath, 'pi', threadID, nativeSessionID)
    try {
      const manager = SessionManager.create('/', directory, { id: nativeSessionID })
      manager.appendMessage({ role: 'user', content: 'Historical input', timestamp: 1 })
      const path = manager.getSessionFile()
      if (path === undefined) throw new Error('Expected native file')
      const entries = [
        { ...manager.getHeader(), version },
        ...manager
          .getEntries()
          .map((entry) =>
            version === 1 && entry.type === 'message'
              ? { type: entry.type, timestamp: entry.timestamp, message: entry.message }
              : entry,
          ),
      ]
      await writeFile(path, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n')
      const reopened = await openPiSession(statePath, threadID, nativeSessionID, {
        storage: 'session',
      })
      expect(reopened.getHeader()?.version).toBe(CURRENT_SESSION_VERSION)
      expect(reopened.getBranch()).toHaveLength(1)
      expect(JSON.stringify(reopened.buildSessionContext().messages)).toContain('Historical input')
    } finally {
      await rm(statePath, { recursive: true, force: true })
    }
  })
}
