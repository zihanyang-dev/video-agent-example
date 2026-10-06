import { expect, test } from 'bun:test'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')

async function snapshot(path: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {}
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) {
      Object.assign(
        files,
        Object.fromEntries(
          Object.entries(await snapshot(child)).map(([name, contents]) => [
            `${entry.name}/${name}`,
            contents,
          ]),
        ),
      )
    } else files[entry.name] = await readFile(child, 'utf8')
  }
  return files
}

test('offline document generation replaces the complete tree reproducibly in an explicit output directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vid-generation-success-'))
  const output = join(directory, 'generated')
  try {
    await mkdir(output)
    await writeFile(join(output, 'obsolete.txt'), 'old artifact')
    const generate = () =>
      Bun.spawn(
        ['bun', join(root, 'scripts/generate-api.ts'), '--outdir', output],
        { stdout: 'ignore', stderr: 'inherit' },
      ).exited
    expect(await generate()).toBe(0)
    const first = await snapshot(output)
    expect(first['obsolete.txt']).toBeUndefined()
    expect(JSON.parse(first['openapi.json']!).openapi).toBe('3.1.0')
    expect(first['authentication.openapi.json']).toBeDefined()
    expect(first['execution-command.schema.json']).toBeDefined()
    expect(first['execution-delivery.schema.json']).toBeDefined()
    expect(Object.keys(first).sort()).toEqual([
      'authentication.openapi.json',
      'execution-command.schema.json',
      'execution-delivery.schema.json',
      'openapi.json',
    ])
    expect(await generate()).toBe(0)
    expect(await snapshot(output)).toEqual(first)
    expect(await readdir(directory)).toEqual(['generated'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)
