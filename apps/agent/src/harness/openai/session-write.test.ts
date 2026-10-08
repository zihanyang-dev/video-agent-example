import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeJSON } from './session'

for (const fault of ['serialize', 'rename'] as const) {
  test(`failed native ${fault} save removes only its temporary and preserves the existing target`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'owned-native-write-'))
    const path = join(directory, 'session.json')
    try {
      if (fault === 'serialize') await writeJSON(path, { retained: 'original native value' })
      else await mkdir(path)
      const failure = await writeJSON(
        path,
        fault === 'serialize' ? { unsupported: 1n } : { replacement: true },
      ).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(Error)
      expect(await readdir(directory)).toEqual(['session.json'])
      if (fault === 'serialize')
        expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
          retained: 'original native value',
        })
      else expect((await stat(path)).isDirectory()).toBe(true)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
}
