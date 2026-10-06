import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

async function tree(directory: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {}
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      Object.assign(
        files,
        Object.fromEntries(
          Object.entries(await tree(path)).map(([name, content]) => [
            `${entry.name}/${name}`,
            content,
          ]),
        ),
      )
    } else {
      files[entry.name] = (await readFile(path)).toString('base64')
    }
  }
  return files
}

const directory = await mkdtemp(join(tmpdir(), 'vid-ci-generation-'))
try {
  const output = join(directory, 'generated')
  const child = Bun.spawn(
    ['bun', 'scripts/generate-api.ts', '--outdir', output],
    { stdout: 'inherit', stderr: 'inherit' },
  )
  assert.equal(await child.exited, 0, 'Native API generation failed')
  assert.deepEqual(
    await tree(output),
    await tree('packages/contract/generated'),
    'Generated API artifacts differ; regenerate with the native generator',
  )
} finally {
  await rm(directory, { recursive: true, force: true })
}
