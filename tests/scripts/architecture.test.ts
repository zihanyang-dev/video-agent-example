import { expect, test } from 'bun:test'
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import type { ICruiseResult } from 'dependency-cruiser'

const root = join(import.meta.dir, '../..')

// Execute the production config/parser against an owned tree. Never insert
// illegal imports into the checkout, and never weaken fixture rule definitions.
async function fixture<T>(
  files: Record<string, string>,
  inspect: (directory: string) => Promise<T>,
) {
  const directory = await mkdtemp(join(tmpdir(), 'vid-architecture-'))
  try {
    await Promise.all([
      copyFile(join(root, '.dependency-cruiser.cjs'), join(directory, '.dependency-cruiser.cjs')),
      copyFile(join(root, 'tsconfig.json'), join(directory, 'tsconfig.json')),
      copyFile(join(root, '.oxlintrc.json'), join(directory, '.oxlintrc.json')),
      symlink(join(root, 'node_modules'), join(directory, 'node_modules')),
      mkdir(join(directory, 'apps'), { recursive: true }),
      mkdir(join(directory, 'packages'), { recursive: true }),
    ])
    // Workspace SDKs must resolve exactly as production, not fail as unresolved
    // before the boundary rule gets to inspect the actual package edge.
    await mkdir(join(directory, 'apps/agent'), { recursive: true })
    await symlink(join(root, 'apps/agent/node_modules'), join(directory, 'apps/agent/node_modules'))
    for (const [path, source] of Object.entries(files)) {
      const destination = join(directory, path)
      await mkdir(dirname(destination), { recursive: true })
      await writeFile(destination, source)
    }
    return await inspect(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const nativeSDKCases = ['@openai/agents', 'openai'].flatMap((sdk) =>
  ['apps/agent/src/execution/run.ts', 'apps/agent/src/contract.ts'].map((path) => ({
    name: `${path} cannot import the ${sdk} SDK`,
    files: {
      [path]:
        sdk === 'openai'
          ? 'export type { OpenAI } from "openai"'
          : 'export type { Session } from "@openai/agents"',
    },
    rules: ['execution-no-agent-sdk'],
  })),
)

const cases: {
  name: string
  files: Record<string, string>
  rules: string[]
}[] = [
  ...nativeSDKCases,
  {
    name: 'legal public type imports stay permitted',
    files: {
      'apps/agent/main.ts':
        'import type { Public } from "@vid/contract/http"; export type View = Public',
      'packages/contract/src/http.ts': 'export type Public = { title: string }',
    },
    rules: [],
  },
  {
    name: 'type-only imports cannot cross application ownership',
    files: {
      'apps/agent/main.ts':
        'import type { Private } from "../server/private"; export type View = Private',
      'apps/server/private.ts': 'export type Private = { secret: string }',
    },
    rules: ['no-cross-app-agent'],
  },
  {
    name: 'shared packages cannot depend on applications',
    files: {
      'packages/config/src/env.ts': 'export { value } from "../../../apps/server/private"',
      'apps/server/private.ts': 'export const value = 1',
    },
    rules: ['shared-not-app'],
  },
  {
    name: 'public HTTP schemas cannot expose execution types',
    files: {
      'packages/contract/src/http.ts': 'export type { Private } from "./execution"',
      'packages/contract/src/execution.ts': 'export type Private = { secret: string }',
    },
    rules: ['http-no-execution-contract'],
  },
  {
    name: 'execution cannot import a concrete harness even through a type',
    files: {
      'apps/agent/src/execution/run.ts': 'export type { Session } from "../harness/pi/adapter"',
      'apps/agent/src/harness/pi/adapter.ts': 'export type Session = { native: string }',
    },
    rules: ['execution-no-harness'],
  },
  {
    name: 'execution cannot import a concrete sandbox adapter',
    files: {
      'apps/agent/src/execution/run.ts': 'export { open } from "../sandbox/e2b"',
      'apps/agent/src/sandbox/e2b.ts': 'export const open = () => {}',
    },
    rules: ['execution-no-sandbox-adapter'],
  },
  {
    name: 'execution cannot import the native harness SDK directly',
    files: {
      'apps/agent/src/execution/run.ts': 'export type { Sandbox } from "e2b"',
    },
    rules: ['execution-no-agent-sdk'],
  },
  {
    name: 'root consumer contract cannot import a concrete harness',
    files: {
      'apps/agent/src/contract.ts': 'export type { Session } from "./harness/pi/adapter"',
      'apps/agent/src/harness/pi/adapter.ts': 'export type Session = { native: string }',
    },
    rules: ['execution-no-harness'],
  },
  {
    name: 'root consumer contract cannot import a concrete sandbox adapter',
    files: {
      'apps/agent/src/contract.ts': 'export { open } from "./sandbox/e2b"',
      'apps/agent/src/sandbox/e2b.ts': 'export const open = () => {}',
    },
    rules: ['execution-no-sandbox-adapter'],
  },
  {
    name: 'root consumer contract cannot import a native SDK',
    files: { 'apps/agent/src/contract.ts': 'export type { Sandbox } from "e2b"' },
    rules: ['execution-no-agent-sdk'],
  },
  {
    name: 'circular imports are rejected',
    files: {
      'apps/server/a.ts': 'import { b } from "./b"; export const a = b',
      'apps/server/b.ts': 'import { a } from "./a"; export const b = a',
    },
    rules: ['no-cycles'],
  },
  {
    name: 'unresolved imports are rejected for their actual rule',
    files: {
      'apps/server/main.ts': 'export { missing } from "./not-present"',
    },
    rules: ['no-unresolved'],
  },
]
for (const scenario of cases) {
  test(scenario.name, async () => {
    await fixture(scenario.files, async (directory) => {
      const process = Bun.spawn(
        [
          'node',
          join(root, 'node_modules/dependency-cruiser/bin/dependency-cruiser.mjs'),
          '--config',
          '.dependency-cruiser.cjs',
          '--output-type',
          'json',
          'apps',
          'packages',
        ],
        {
          cwd: directory,
          stdout: 'pipe',
          stderr: 'pipe',
          timeout: 3000,
          killSignal: 'SIGKILL',
        },
      )
      const [output, errors, status] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
      ])
      const report = JSON.parse(output) as ICruiseResult
      expect(
        [...new Set(report.summary.violations.map((violation) => violation.rule.name))].sort(),
        errors + JSON.stringify(report.modules),
      ).toEqual(scenario.rules)
      // The native JSON reporter always exits 0. Actual rule records, not a
      // generic CLI failure, prove that the production boundary rejected it.
      expect(status).toBe(0)
    })
  })
}

for (const scenario of [
  {
    path: 'apps/server/illegal.ts',
    source: 'export const value = process.env.DATABASE_URL',
    allowed: false,
  },
  {
    path: 'apps/agent/illegal.ts',
    source: 'export const value = Bun.env.MODEL_API_KEY',
    allowed: false,
  },
  {
    path: 'packages/config/src/env.ts',
    source: 'export const value = process.env.DATABASE_URL',
    allowed: true,
  },
  {
    path: 'apps/server/legal.test.ts',
    source: 'export const value = process.env.DATABASE_URL',
    allowed: true,
  },
]) {
  test(`environment boundary ${scenario.path}`, async () => {
    await fixture({ [scenario.path]: scenario.source }, async (directory) => {
      const process = Bun.spawn(
        [
          join(root, 'node_modules/oxlint/bin/oxlint'),
          '--config',
          '.oxlintrc.json',
          '--deny-warnings',
          scenario.path,
        ],
        {
          cwd: directory,
          stdout: 'pipe',
          stderr: 'pipe',
          timeout: 3000,
          killSignal: 'SIGKILL',
        },
      )
      const [output, errors, status] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
      ])
      expect(status).toBe(scenario.allowed ? 0 : 1)
      if (!scenario.allowed) expect(output + errors).toContain('no-restricted-properties')
    })
  })
}
