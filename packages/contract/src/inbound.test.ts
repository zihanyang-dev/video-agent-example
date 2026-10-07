import { expect, test } from 'bun:test'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import * as execution from './execution'

const id = 'ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF'
const canonical = id.toLowerCase()
const file = {
  objectKey: 'materials/UNCHANGED/old-key',
  name: '剪辑.txt',
  mimeType: 'text/plain',
  byteLength: 3,
  sha256: 'a'.repeat(64),
}
const command = {
  version: 1,
  kind: 'start',
  commandID: id,
  threadID: id,
  runID: id,
  input: { messageID: id, text: '  preserved\ntext  ' },
} as const
const event = {
  version: 1,
  kind: 'run-completed',
  eventID: id,
  threadID: id,
  runID: id,
  messageID: id,
  text: '  result\n',
} as const
const commandSchema = execution.inboundExecutionCommandSchema
const deliverySchema = execution.inboundExecutionDeliverySchema

test('inbound command upgrades retained materials preserving identities, bytes, keys and order', () => {
  const second = 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB'
  const materials = [
    { materialID: id, ...file },
    { materialID: second, ...file, name: 'second.txt' },
  ]
  const parsed = commandSchema.parse({
    ...command,
    input: { ...command.input, materials },
  })
  expect(parsed).toEqual({
    ...command,
    commandID: canonical,
    threadID: canonical,
    runID: canonical,
    input: {
      ...command.input,
      messageID: canonical,
      assets: [
        { assetID: canonical, ...file },
        { assetID: second.toLowerCase(), ...file, name: 'second.txt' },
      ],
    },
  })
  expect(Reflect.set(parsed, 'runID', 'replacement')).toBe(false)
  if (parsed.kind !== 'start') throw new Error('Expected start')
  expect(Reflect.set(parsed.input, 'text', 'replacement')).toBe(false)
  expect(Reflect.set(parsed.input.assets!, '0', null)).toBe(false)
  expect(
    execution.executionCommandSchema.safeParse({
      ...command,
      input: { ...command.input, materials },
    }).success,
  ).toBe(false)
  expect(
    commandSchema.parse({
      ...command,
      input: { ...command.input, materials: [] },
    }),
  ).toEqual(commandSchema.parse(command))
  expect(
    commandSchema.safeParse({
      ...command,
      input: { ...command.input, text: '', materials: [] },
    }).success,
  ).toBe(false)
  expect(
    commandSchema.parse({
      ...command,
      input: { ...command.input, text: '', materials },
    }),
  ).toHaveProperty('input.assets')
})

test('inbound delivery upgrades artifacts and retains absent versus explicit empty lists', () => {
  const artifacts = [
    { artifactID: id, ...file, objectKey: 'artifacts/UNCHANGED/old-key' },
    {
      artifactID: 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB',
      ...file,
      name: 'second.txt',
      objectKey: 'artifacts/UNCHANGED/second-key',
    },
  ]
  const parsed = deliverySchema.parse({
    ordinal: 7,
    event: { ...event, artifacts },
  })
  expect(parsed).toEqual({
    ordinal: 7,
    event: {
      ...event,
      eventID: canonical,
      threadID: canonical,
      runID: canonical,
      messageID: canonical,
      assets: [
        {
          assetID: canonical,
          ...file,
          objectKey: 'artifacts/UNCHANGED/old-key',
        },
        {
          assetID: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          ...file,
          name: 'second.txt',
          objectKey: 'artifacts/UNCHANGED/second-key',
        },
      ],
    },
  })
  expect(
    deliverySchema.parse({ ordinal: 7, event: { ...event, artifacts: [] } }).event,
  ).toHaveProperty('assets', [])
  expect(deliverySchema.parse({ ordinal: 7, event }).event).not.toHaveProperty('assets')
  expect(
    execution.executionDeliverySchema.safeParse({
      ordinal: 7,
      event: { ...event, artifacts },
    }).success,
  ).toBe(false)
})

test('inbound schemas accept current envelopes and reject ambiguous aliases and unknown fields', () => {
  const asset = { assetID: id, ...file }
  const current = { ...command, input: { ...command.input, assets: [asset] } }
  expect(commandSchema.parse(current)).toEqual(execution.executionCommandSchema.parse(current))
  const currentDelivery = { ordinal: 2, event: { ...event, assets: [asset] } }
  expect(deliverySchema.parse(currentDelivery)).toEqual(
    execution.executionDeliverySchema.parse(currentDelivery),
  )
  for (const input of [
    { ...command.input, materials: [], assets: [] },
    { ...command.input, materials: [], assets: [asset] },
    { ...command.input, materials: [{ materialID: id, assetID: id, ...file }] },
    {
      ...command.input,
      materials: [{ materialID: id, ...file, private: true }],
    },
    { ...command.input, materials: [], private: true },
  ])
    expect(commandSchema.safeParse({ ...command, input }).success).toBe(false)
  for (const extra of [
    { artifacts: [], assets: [] },
    { artifacts: [], assets: [asset] },
    { artifacts: [{ artifactID: id, assetID: id, ...file }] },
    { artifacts: [{ artifactID: id, ...file, private: true }] },
    { artifacts: [], private: true },
  ])
    expect(deliverySchema.safeParse({ ordinal: 2, event: { ...event, ...extra } }).success).toBe(
      false,
    )
  expect(deliverySchema.safeParse({ ordinal: 2, event, private: true }).success).toBe(false)
  expect(commandSchema.safeParse({ ...command, private: true }).success).toBe(false)
  expect(
    commandSchema.parse({
      version: 1,
      kind: 'cancel',
      commandID: id,
      threadID: id,
      runID: id,
    }),
  ).toHaveProperty('commandID', canonical)
})

test('normative foreign wire schemas do not advertise inbound legacy aliases', () => {
  const ajv = new Ajv2020({ strict: true })
  addFormats(ajv)
  const schemas = execution.executionJSONSchemas()
  const validateCommand = ajv.compile(schemas.command)
  const validateDelivery = ajv.compile(schemas.delivery)
  expect(validateCommand(command)).toBe(true)
  expect(validateCommand({ ...command, input: { ...command.input, materials: [] } })).toBe(false)
  expect(validateDelivery({ ordinal: 1, event })).toBe(true)
  expect(validateDelivery({ ordinal: 1, event: { ...event, artifacts: [] } })).toBe(false)
})
