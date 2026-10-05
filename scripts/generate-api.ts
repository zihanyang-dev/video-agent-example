import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { betterAuth } from 'better-auth'
import { generateSpecs, type GenerateSpecOptions } from 'hono-openapi'
import { publicJSONSchemas } from '@vid/contract/http'
import { executionJSONSchemas } from '@vid/contract/execution'
import { createRouter } from '../apps/server/src/http'
import { authenticationOptions } from '../apps/server/src/identity/authentication'

// Fixed offline metadata, no application connections, credentials or timestamps.
const output = resolve(import.meta.dir, '../packages/contract/generated')
await mkdir(output, { recursive: true })
// Redis carries private JSON envelopes, not HTTP operations or AG-UI frames.
for (const [name, schema] of Object.entries(executionJSONSchemas()))
  await Bun.write(
    `${output}/execution-${name}.schema.json`,
    `${JSON.stringify(schema, null, 2)}\n`,
  )

const schemas = publicJSONSchemas()
const spec = await generateSpecs(createRouter(), {
  documentation: {
    openapi: '3.1.0',
    info: {
      title: 'Video Agent Public API',
      version: '1.0.0',
      description:
        'Cookie authentication and canonical-origin writes. Product JSON bodies are limited to 65536 bytes. Runtime constraints and official AG-UI custom values are not fully representable as JSON Schema.',
    },
    components: {
      // Hono OpenAPI's component declaration still narrows JSON Schema to
      // OpenAPI 3.0. The emitted document is 3.1 and uses native 2020-12 schemas;
      // independent AJV tests validate the conversion rather than weakening it.
      schemas: schemas as NonNullable<
        NonNullable<
          GenerateSpecOptions['documentation']['components']
        >['schemas']
      >,
      securitySchemes: {
        sessionCookie: {
          type: 'apiKey',
          in: 'cookie',
          name: 'better-auth.session_token',
          description:
            'Native Better Auth signed cookie; production cookie naming follows SDK configuration.',
        },
      },
    },
  },
})
await Bun.write(`${output}/openapi.json`, `${JSON.stringify(spec, null, 2)}\n`)
// The auth SDK spec remains separate: it owns its routes and DTOs. Omitting the
// DB in the exact same options selects its offline adapter; schema generation
// invokes no identity query, provider request or app connection constructor.
const auth = betterAuth(
  authenticationOptions(undefined, {
    baseURL: 'http://localhost:8787',
    secret: 'offline-schema-generation-not-a-production-secret',
    githubClientID: 'offline-schema-generation',
    githubClientSecret: 'offline-schema-generation',
  }),
)
const authSpec = await auth.api.generateOpenAPISchema()
await Bun.write(
  `${output}/authentication.openapi.json`,
  `${JSON.stringify(authSpec, null, 2)}\n`,
)
// Resolve from the contract workspace: Hey API uses the TS6 compiler API,
// while the application's formal typechecker remains TS7.
const generator: typeof import('@hey-api/openapi-ts') = await import(
  import.meta.resolve(
    '@hey-api/openapi-ts',
    resolve(import.meta.dir, '../packages/contract/package.json'),
  )
)
// Publish the official SDK as JS + declarations, not TS implementation files.
// Its runtime targets non-exact optionals; applications still typecheck strict
// DTO declarations with their own TS7 settings. No SDK templates are patched.
const source = await mkdtemp(join(tmpdir(), 'vid-public-sdk-'))
try {
  await generator.createClient({
    input: `${output}/openapi.json`,
    output: { path: source, module: { extension: '.js' } },
    plugins: ['@hey-api/typescript', '@hey-api/client-fetch', '@hey-api/sdk'],
  })
  const compiler = import.meta.resolve(
    'typescript',
    resolve(import.meta.dir, '../packages/contract/package.json'),
  )
  const emission = Bun.spawn(
    [
      'bun',
      fileURLToPath(new URL('./tsc.js', compiler)),
      '--target',
      'ES2022',
      '--module',
      'ESNext',
      '--moduleResolution',
      'Bundler',
      '--lib',
      'ESNext,DOM,DOM.Iterable',
      '--strict',
      '--skipLibCheck',
      '--declaration',
      '--rootDir',
      source,
      '--outDir',
      `${source}/emitted`,
      `${source}/index.ts`,
      `${source}/client/index.ts`,
    ],
    { cwd: source, stdout: 'inherit', stderr: 'inherit' },
  )
  if ((await emission.exited) !== 0)
    throw new Error('Official SDK declaration emission failed')
  await rm(`${output}/client`, { recursive: true, force: true })
  await cp(`${source}/emitted`, `${output}/client`, { recursive: true })
} finally {
  await rm(source, { recursive: true, force: true })
}
