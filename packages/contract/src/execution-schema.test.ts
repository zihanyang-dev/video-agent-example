import { expect, test } from 'bun:test'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import {
  executionJSONSchemas,
  executionCommandSchema,
  executionDeliverySchema,
} from './execution'

const identity = '11111111-1111-4111-8111-111111111111'
const reference = {
  assetID: identity,
  objectKey: 'assets/uploads/allocated',
  name: 'source.txt',
  mimeType: 'text/plain',
  byteLength: 3,
  sha256: 'a'.repeat(64),
}

test('foreign JSON Schema consumers enforce real command and delivery boundaries', () => {
  const schemas = executionJSONSchemas()
  const validator = new Ajv2020({ strict: true })
  addFormats(validator)
  const command = validator.compile(schemas.command)
  const delivery = validator.compile(schemas.delivery)
  const start = {
    version: 1,
    kind: 'start',
    commandID: identity,
    threadID: identity,
    runID: identity,
    input: { messageID: identity, text: 'hello' },
  }
  const samples = [
    start,
    { ...start, version: 2 },
    { ...start, input: { ...start.input, text: ' \n\t\uFEFF' } },
    { ...start, input: { ...start.input, text: '', assets: [reference] } },
    { ...start, input: { ...start.input, text: '', assets: [] } },
    {
      ...start,
      input: {
        ...start.input,
        assets: [{ ...reference, name: '../source.txt' }],
      },
    },
    {
      ...start,
      input: { ...start.input, assets: [{ ...reference, name: '.' }] },
    },
    {
      ...start,
      input: {
        ...start.input,
        assets: [{ ...reference, name: 'bad\u0000name' }],
      },
    },
    { ...start, privateHistory: [] },
    {
      version: 1,
      kind: 'cancel',
      commandID: identity.toUpperCase(),
      threadID: identity,
      runID: identity,
    },
  ]
  for (const value of samples)
    expect(command(value)).toBe(executionCommandSchema.safeParse(value).success)
  for (const name of [
    '.',
    '..',
    'file\n',
    'file\r',
    'file\u007f',
    'bad/name',
    'bad\\name',
  ]) {
    const value = {
      ...start,
      input: { ...start.input, assets: [{ ...reference, name }] },
    }
    expect(executionCommandSchema.safeParse(value).success).toBeFalse()
    expect(command(value)).toBeFalse()
  }
  const event = {
    version: 1,
    kind: 'run-failed',
    eventID: identity,
    threadID: identity,
    runID: identity,
    reason: 'sandbox-recovery-required',
  }
  for (const value of [
    { ordinal: 1, event },
    { ordinal: 0, event },
    { ordinal: 1, event: { ...event, privateHistory: [] } },
  ])
    expect(delivery(value)).toBe(
      executionDeliverySchema.safeParse(value).success,
    )
  expect(JSON.stringify(schemas)).not.toContain('readOnly')
  expect(executionJSONSchemas()).toEqual(schemas)
})
