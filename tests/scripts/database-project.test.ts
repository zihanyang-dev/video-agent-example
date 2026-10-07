import { expect, test } from 'bun:test'
import { readFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const script = join(import.meta.dir, '../../scripts/database-check.sh')

for (const mode of ['generate', 'verify'])
  test(`${mode} rejects trailing arguments before any fixture allocation`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'vid-database-arguments-'))
    const marker = join(directory, 'allocated')
    try {
      for (const command of ['mktemp', 'docker'])
        writeFileSync(
          join(directory, command),
          '#!/bin/sh\nprintf allocated > "$VID_TEST_ALLOCATION_MARKER"\nexit 71\n',
          { mode: 0o700 },
        )
      const result = spawnSync('sh', [script, mode, 'unexpected'], {
        encoding: 'utf8',
        timeout: 3000,
        killSignal: 'SIGKILL',
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH ?? ''}`,
          VID_TEST_ALLOCATION_MARKER: marker,
          VID_CHECK_IMAGE: 'unused-arguments-probe',
        },
      })
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(2)
      expect(result.stderr).toContain('do not accept test arguments')
      expect(existsSync(marker)).toBe(false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

test('database fixture project names accept mixed-case temporary directories', () => {
  const source = readFileSync(script, 'utf8')
  const boundary = source.indexOf('\nhas_network=1\n')
  expect(boundary).toBeGreaterThan(0)
  const directory = mkdtempSync(join(tmpdir(), 'vid-project-name-'))
  const staging = join(directory, 'tmp.tnPSIGmbmh')
  mkdirSync(staging)
  try {
    // Execute the runner's real setup, stopping before any Docker resources.
    // Control only mktemp's output; ownership, config and cleanup remain real.
    const result = spawnSync(
      'sh',
      [
        '-ec',
        `mktemp() { printf '%s\\n' "$VID_TEST_STAGING"; }
${source.slice(0, boundary)}
printf '%s\\n' "$owner"`,
        script,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          VID_CHECK_IMAGE: 'unused-project-name-probe',
          VID_TEST_STAGING: staging,
        },
      },
    )
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toMatch(/^[a-z0-9][a-z0-9_-]*$/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
