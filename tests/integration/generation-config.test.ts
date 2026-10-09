import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { openTestDatabase } from './database-fixture'

const databaseDirectory = join(import.meta.dir, '../../packages/database')
const sourceScript = join(import.meta.dir, '../../scripts/generate-database.sh')
const sourceTypes = join(databaseDirectory, 'generated/db.ts')

function runGeneration(script: string, directory: string, deadline = '10s') {
  // Kill the entire process group; a TERM-exiting shell can orphan a TERM-ignoring writer.
  return spawnSync('timeout', ['--signal=KILL', deadline, 'sh', script], {
    cwd: directory,
    encoding: 'utf8',
  })
}

for (const [name, config] of [
  ['schema exclusion', { excludePattern: 'execution.*' }],
  ['column type mapping', { typeMapping: { int4: 'UntrustedAmbientType' } }],
  ['connection URL', { url: 'postgresql://fixture:fixture@127.0.0.1:1/forbidden' }],
] as const) {
  test(`database generation ignores ambient ${name} and replaces its staged output canonically`, async () => {
    const { db, close } = openTestDatabase()
    const directory = mkdtempSync(join(databaseDirectory, '.generation-case-'))
    const target = join(directory, 'packages/database')
    const generated = join(target, 'generated/db.ts')
    try {
      mkdirSync(join(directory, 'scripts'))
      mkdirSync(join(target, 'generated'), { recursive: true })
      copyFileSync(sourceScript, join(directory, 'scripts/generate-database.sh'))
      copyFileSync(join(databaseDirectory, 'package.json'), join(target, 'package.json'))
      // Verify the launcher-issued database capability before invoking the real generator.
      await db.selectFrom('execution.runs').select('run_id').limit(1).execute()
      writeFileSync(generated, 'Owned output that the generator must replace\n')
      writeFileSync(join(target, '.kysely-codegenrc.json'), JSON.stringify(config))
      const result = runGeneration(join(directory, 'scripts/generate-database.sh'), target)
      expect(result.error).toBeUndefined()
      expect(result.status, result.stderr).toBe(0)
      expect(readFileSync(generated, 'utf8')).toBe(readFileSync(sourceTypes, 'utf8'))
      expect(
        readdirSync(join(target, 'generated')).filter((entry) => entry.startsWith('.db-types-')),
      ).toEqual([])
    } finally {
      rmSync(directory, { recursive: true, force: true })
      await close()
    }
  }, 20000)
}

test('generation deadline joins descendants before the fixture removes their output directory', async () => {
  const directory = mkdtempSync(join(databaseDirectory, '.generation-lifetime-'))
  const script = join(directory, 'writer.sh')
  try {
    writeFileSync(script, 'sh -c \'trap "" TERM; sleep 0.4; printf late > late-write\' &\nwait\n')
    const result = runGeneration(script, directory, '0.1s')
    // The bounded probe finishes even for the broken single-parent/TERM variants.
    await Bun.sleep(600)
    expect(result.status).not.toBe(0)
    expect(existsSync(join(directory, 'late-write'))).toBe(false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
