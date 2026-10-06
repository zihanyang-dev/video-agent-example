import { expect, test } from 'bun:test'
import Ajv from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { fileNameSchema } from './file-name'
import { publicAssetSchema, publicJSONSchemas } from './http'
import { executionCommandSchema, executionJSONSchemas } from './execution'

const id = '11111111-1111-4111-8111-111111111111'
const ajv = new Ajv({ strict: true })
addFormats(ajv)
const publicAsset = ajv.compile(publicJSONSchemas().PublicAsset!)
const command = ajv.compile(executionJSONSchemas().command)

// Literal expectations protect membership and record the intentional difference
// between runtime UTF-16 lengths and JSON Schema code-point lengths.
const cases: readonly (readonly [string, boolean, boolean])[] = [
  ['', false, false],
  ['.', false, false],
  ['..', false, false],
  ['...', true, true],
  ['.hidden', true, true],
  ['../secret', false, false],
  ['bad/name', false, false],
  ['bad\\name', false, false],
  ['file\n', false, false],
  ['file\r', false, false],
  ...Array.from({ length: 32 }, (_, code): [string, boolean, boolean] => [
    `file${String.fromCharCode(code)}.txt`,
    false,
    false,
  ]),
  ['file\u007f.txt', false, false],
  ['电影.txt', true, true],
  ['🎬.txt', true, true],
  ['line\u2028.txt', true, true],
  ['\u0080.txt', true, true],
  ['\ud800', true, true],
  ['\udc00', true, true],
  ['x'.repeat(255), true, true],
  ['x'.repeat(256), false, false],
  ['电'.repeat(255), true, true],
  ['电'.repeat(256), false, false],
  ['🎬'.repeat(127) + 'a', true, true],
  ['🎬'.repeat(128), false, true],
  ['🎬'.repeat(255), false, true],
  ['🎬'.repeat(256), false, false],
]

test.each(cases)(
  'filename %j has native acceptance %j and foreign acceptance %j at both boundaries',
  (name, native, foreign) => {
    const asset = {
      assetID: id,
      source: 'upload',
      name,
      mimeType: 'text/plain',
      byteLength: 1,
      createdAt: '2026-10-04T00:00:00.000Z',
    }
    const start = {
      version: 1,
      kind: 'start',
      commandID: id,
      threadID: id,
      runID: id,
      input: {
        messageID: id,
        text: '',
        assets: [
          {
            assetID: id,
            objectKey: 'assets/uploads/allocated',
            name,
            mimeType: 'text/plain',
            byteLength: 1,
            sha256: 'a'.repeat(64),
          },
        ],
      },
    }
    expect(fileNameSchema.safeParse(name).success).toBe(native)
    expect(publicAssetSchema.safeParse(asset).success).toBe(native)
    expect(publicAsset(asset)).toBe(foreign)
    expect(executionCommandSchema.safeParse(start).success).toBe(native)
    expect(command(start)).toBe(foreign)
  },
)
