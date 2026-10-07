import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { betterAuth } from 'better-auth'
import { generateSpecs, type GenerateSpecOptions } from 'hono-openapi'
import { publicJSONSchemas } from '@vid/contract/http'
import { executionJSONSchemas } from '@vid/contract/execution'
import { createRouter } from '../apps/server/src/http'
import { authenticationOptions } from '../apps/server/src/identity/authentication'

type OpenAPIComponents = NonNullable<GenerateSpecOptions['documentation']['components']>
type OpenAPISchemas = NonNullable<OpenAPIComponents['schemas']>

async function generateDocuments(output: string) {
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
        schemas: schemas as OpenAPISchemas,
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
  await Bun.write(`${output}/authentication.openapi.json`, `${JSON.stringify(authSpec, null, 2)}\n`)
}

const { values } = parseArgs({ options: { outdir: { type: 'string' } } })
const output = resolve(values.outdir ?? resolve(import.meta.dir, '../packages/contract/generated'))
await mkdir(dirname(output), { recursive: true })
const staging = await mkdtemp(join(dirname(output), `.${basename(output)}-stage-`))
try {
  await generateDocuments(staging)
  await rm(output, { recursive: true, force: true })
  await rename(staging, output)
} finally {
  await rm(staging, { recursive: true, force: true })
}
