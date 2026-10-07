import { expect, test } from 'bun:test'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { executionJSONSchemas, executionCommandSchema, executionDeliverySchema } from './execution'

const identity = 'abcdefab-cdef-4abc-8def-abcdefabcdef'
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
    { value: start, valid: true },
    { value: { ...start, version: 2 }, valid: false },
    {
      value: { ...start, input: { ...start.input, text: ' \n\t\uFEFF' } },
      valid: false,
    },
    {
      value: {
        ...start,
        input: { ...start.input, text: '', assets: [reference] },
      },
      valid: true,
    },
    {
      value: { ...start, input: { ...start.input, text: '', assets: [] } },
      valid: false,
    },
    {
      value: {
        ...start,
        input: {
          ...start.input,
          assets: [{ ...reference, name: '../source.txt' }],
        },
      },
      valid: false,
    },
    {
      value: {
        ...start,
        input: { ...start.input, assets: [{ ...reference, name: '.' }] },
      },
      valid: false,
    },
    {
      value: {
        ...start,
        input: {
          ...start.input,
          assets: [{ ...reference, name: 'bad\u0000name' }],
        },
      },
      valid: false,
    },
    { value: { ...start, privateHistory: [] }, valid: false },
    {
      value: {
        version: 1,
        kind: 'cancel',
        commandID: identity.toUpperCase(),
        threadID: identity,
        runID: identity,
      },
      valid: true,
    },
    { value: { ...start, commandID: identity.toUpperCase() }, valid: true },
    { value: { ...start, commandID: 'not-a-uuid' }, valid: false },
  ]
  for (const { value, valid } of samples) {
    expect(executionCommandSchema.safeParse(value).success).toBe(valid)
    expect(command(value)).toBe(valid)
  }
  for (const name of ['.', '..', 'file\n', 'file\r', 'file\u007f', 'bad/name', 'bad\\name']) {
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
  for (const { value, valid } of [
    { value: { ordinal: 1, event }, valid: true },
    { value: { ordinal: 0, event }, valid: false },
    {
      value: { ordinal: 1, event: { ...event, privateHistory: [] } },
      valid: false,
    },
  ]) {
    expect(executionDeliverySchema.safeParse(value).success).toBe(valid)
    expect(delivery(value)).toBe(valid)
  }
  expect(JSON.stringify(schemas)).not.toContain('readOnly')
})
