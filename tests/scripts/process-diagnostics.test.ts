import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

for (const kind of ['worker', 'server'] as const) {
  test(`${kind} entrypoint returns failure without printing private native rejection`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vid-process-diagnostic-'))
    const marker = `PRIVATE_NATIVE_REJECTION_${kind}_143a092b`
    try {
      const preload = join(directory, 'native-connect-fault.ts')
      await writeFile(
        preload,
        kind === 'worker'
          ? `import { WorkerProcess } from ${JSON.stringify(resolve('apps/agent/src/worker.ts'))}; WorkerProcess.prototype.connect = async function () { throw new Error(${JSON.stringify(marker)}); };`
          : `import { createClient } from ${JSON.stringify(import.meta.resolve('redis'))};
for (let prototype = Object.getPrototypeOf(createClient()); prototype; prototype = Object.getPrototypeOf(prototype)) {
  if (!Object.hasOwn(prototype, 'connect')) continue;
  prototype.connect = async function () { throw new Error(${JSON.stringify(marker)}); };
  break;
}`,
      )
      const child = Bun.spawn(
        [
          process.execPath,
          '--preload',
          preload,
          `apps/${kind === 'worker' ? 'agent' : 'server'}/src/main.ts`,
        ],
        {
          env: {
            DATABASE_URL:
              'postgres://fixture:fixture@127.0.0.1:1/fixture?sslmode=disable',
            REDIS_URL: 'redis://127.0.0.1:1',
            IO_TIMEOUT_MS: '1000',
            MODEL_BASE_URL: 'http://unused.invalid',
            MODEL_API_KEY: 'fixture',
            MODEL_ID: 'fixture',
            MODEL_CONTEXT_WINDOW: '4096',
            MODEL_MAX_OUTPUT_TOKENS: '1024',
            MODEL_PROMPT_PATH: resolve('apps/agent/prompt.md'),
            E2B_API_URL: 'http://unused.invalid',
            E2B_API_KEY: 'fixture',
            E2B_SANDBOX_URL: 'http://unused.invalid',
            OBJECT_STORAGE_URL: 'http://127.0.0.1:1',
            OBJECT_STORAGE_REGION: 'fixture',
            OBJECT_STORAGE_BUCKET: 'fixture',
            OBJECT_STORAGE_ACCESS_KEY_ID: 'fixture',
            OBJECT_STORAGE_SECRET_ACCESS_KEY: 'fixture',
            AUTH_BASE_URL: 'http://localhost:8787',
            AUTH_SECRET: 'fixture-only-secret-at-least-32-characters',
            GITHUB_CLIENT_ID: 'fixture',
            GITHUB_CLIENT_SECRET: 'fixture',
          },
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
          timeout: 5000,
          killSignal: 'SIGKILL',
        },
      )
      const [status, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(status).toBe(1)
      expect(stderr).toContain('Process stopped after failure')
      expect(stdout + stderr).not.toContain(marker)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
}
