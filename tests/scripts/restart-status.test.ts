import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const source = readFileSync(new URL('../sandbox/restart-check.sh', import.meta.url), 'utf8')
const start = source.indexOf('cleanup() {')
const end = source.indexOf('# Both the SDK test image', start)
if (start < 0 || end <= start) throw new Error('Missing restart cleanup owner')
const cleanup = source.slice(start, end)

function runCleanup(options: {
  primary: number
  attempted: number
  sshFailure: number
  removeFailure: number
  signal?: 'HUP' | 'INT' | 'TERM'
}) {
  // Consume but never execute the actual remote heredoc. No SSH/Docker/VM.
  const input = `set -eu
owner=owned-test-runner
staging=owned-test-staging
remote_attempted=${options.attempted}
ssh_vm() {
 printf 'ssh:%s\\n' "$*"
 while IFS= read -r line; do :; done
 return ${options.sshFailure}
}
rm() { printf 'rm:%s\\n' "$*"; return ${options.removeFailure}; }
${cleanup}
${options.signal ? `kill -s ${options.signal} $$` : `exit ${options.primary}`}
`
  const result = spawnSync('/bin/sh', ['-s'], {
    input,
    encoding: 'utf8',
    timeout: 5000,
    killSignal: 'SIGKILL',
  })
  expect(result.error).toBeUndefined()
  expect(result.signal).toBeNull()
  const failed =
    options.removeFailure !== 0 || (options.attempted === 1 && options.sshFailure !== 0)
  expect(result.status).toBe(options.primary || Number(failed))
  expect(result.stdout.trim().split('\n')).toEqual([
    ...(options.attempted === 1 ? ['ssh:sh -s -- owned-test-runner'] : []),
    'rm:-rf owned-test-staging',
  ])
  expect(result.stderr.includes('Cleanup incomplete')).toBe(failed)
}

test('restart cleanup preserves primary status and attempts independent cleanup', () => {
  const cases = [
    { attempted: 0, sshFailure: 0, removeFailure: 0 },
    { attempted: 0, sshFailure: 0, removeFailure: 1 },
    { attempted: 0, sshFailure: 1, removeFailure: 0 },
    { attempted: 0, sshFailure: 1, removeFailure: 1 },
    { attempted: 1, sshFailure: 0, removeFailure: 0 },
    { attempted: 1, sshFailure: 0, removeFailure: 1 },
    { attempted: 1, sshFailure: 1, removeFailure: 0 },
    { attempted: 1, sshFailure: 1, removeFailure: 1 },
  ]
  for (const primary of [2, 0, 129, 130, 143]) {
    for (const scenario of cases) runCleanup({ primary, ...scenario })
  }
})

for (const { signal, primary } of [
  { signal: 'HUP', primary: 129 },
  { signal: 'INT', primary: 130 },
  { signal: 'TERM', primary: 143 },
] as const) {
  test(`restart ${signal} trap retains its signal status when cleanup fails`, () => {
    runCleanup({
      signal,
      primary,
      attempted: 1,
      sshFailure: 1,
      removeFailure: 1,
    })
  })
}
