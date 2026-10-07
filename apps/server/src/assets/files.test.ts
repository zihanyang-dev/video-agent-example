import { expect, test } from 'bun:test'
import { validateFile, validGeneratedAssets } from './files'
test('file authority rejects paths, spoofed signatures, and accepts real bytes', () => {
  expect(
    validateFile('../image.png', 'image/png', new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])),
  ).toBe(false)
  expect(validateFile('image.png', 'image/png', new Uint8Array([1]))).toBe(false)
  expect(validateFile('note.txt', 'text/plain', new TextEncoder().encode('hello'))).toBe(true)
  expect(validateFile('note.txt', 'text/html', new TextEncoder().encode('<script>'))).toBe(false)
})

for (const mimeType of ['constructor', 'toString', '__proto__'])
  test(`inherited property ${mimeType} is not an accepted MIME type`, () => {
    expect(validateFile('note.txt', mimeType, new TextEncoder().encode('hello'))).toBe(false)
  })

test('UTF-8 attachment names remain names without becoming paths or header controls', () => {
  const bytes = new TextEncoder().encode('hello')
  expect(validateFile('剪辑 "take".txt', 'text/plain', bytes)).toBe(true)
  for (const name of ['../bad.txt', 'bad\\file.txt', 'bad\r\nheader.txt', '.', '..'])
    expect(validateFile(name, 'text/plain', bytes)).toBe(false)
})

const query = {
  threadID: 'aaaaaaaa-0000-4000-8000-000000000001',
  runID: 'bbbbbbbb-0000-4000-8000-000000000002',
}
const MiB = 1024 * 1024
const limits = { maxBytes: 8 * MiB, maxFiles: 2 }
function reference(index: number, byteLength: number, legacy = false) {
  const assetID = `cccccccc-0000-4000-8000-${String(index).padStart(12, '0')}`
  return {
    assetID,
    name: '输出.txt',
    mimeType: 'text/plain',
    byteLength,
    sha256: 'a'.repeat(64),
    objectKey: `${legacy ? 'artifacts' : 'assets/generated'}/${query.threadID}/${query.runID}/7/${assetID}`,
  }
}

test('legacy metadata retains the physical per-file bound and 32-output protocol bound', () => {
  const assets = Array.from({ length: 32 }, (_, index) => reference(index, 16 * MiB, true))
  expect(validGeneratedAssets(query, assets, limits)).toBe(true)
  expect(validGeneratedAssets(query, [...assets, reference(32, 0, true)], limits)).toBe(false)
  expect(validGeneratedAssets(query, [reference(0, 16 * MiB + 1, true)], limits)).toBe(false)
})

test('current and mixed metadata still enforce current aggregate and count budgets', () => {
  const legacy = reference(0, 10 * MiB, true)
  const current = reference(1, 8 * MiB)
  expect(validGeneratedAssets(query, [legacy, current], limits)).toBe(true)
  expect(validGeneratedAssets(query, [legacy, current, reference(2, 1)], limits)).toBe(false)
  expect(validGeneratedAssets(query, [current, reference(2, 1)], limits)).toBe(false)
  expect(validGeneratedAssets(query, [reference(1, 8 * MiB + 1)], limits)).toBe(false)
  expect(
    validGeneratedAssets(
      query,
      [legacy, reference(1, 0), reference(2, 0), reference(3, 0)],
      limits,
    ),
  ).toBe(false)
})

test('legacy budget exception never admits foreign or malformed references', () => {
  for (const legacy of [true, false]) {
    const asset = reference(1, 1, legacy)
    for (const patch of [
      {
        objectKey: asset.objectKey.replace(query.threadID, crypto.randomUUID()),
      },
      { objectKey: asset.objectKey.replace(query.runID, crypto.randomUUID()) },
      {
        objectKey: asset.objectKey.replace(asset.assetID, crypto.randomUUID()),
      },
      { objectKey: asset.objectKey.replace('/7/', '/0/') },
      { objectKey: `${asset.objectKey}/extra` },
      { name: '../foreign.txt' },
      { name: 'foreign.txt\n' },
      { sha256: 'invalid' },
      { byteLength: 0.5 },
      { byteLength: -1 },
    ])
      expect(validGeneratedAssets(query, [{ ...asset, ...patch }], limits)).toBe(false)
  }
})
