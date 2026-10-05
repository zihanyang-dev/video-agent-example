import { afterAll, expect, test } from 'bun:test'
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { connectObjects, sha256 } from '@vid/object-storage'
import { storageSettings } from '../integration/authentication-fixture'

const endpoint = process.env.STORAGE_TEST_ENDPOINT
if (!endpoint) throw new Error('Dedicated storage test endpoint required')
const connection = {
  endpoint,
  region: storageSettings.OBJECT_STORAGE_REGION,
  bucket: storageSettings.OBJECT_STORAGE_BUCKET,
  accessKeyID: storageSettings.OBJECT_STORAGE_ACCESS_KEY_ID,
  secretAccessKey: storageSettings.OBJECT_STORAGE_SECRET_ACCESS_KEY,
}
const objects = connectObjects(connection)
afterAll(() => objects.close())

// The runner destroys its own entire storage container. Application credentials
// cannot delete immutable assets, including those published by this fixture.
test('S3 preserves binary bytes and rejects oversized, conflicting, unauthorized and pre-aborted I/O', async () => {
  const key = `assets/uploads/${crypto.randomUUID()}/${crypto.randomUUID()}`
  const bytes = new Uint8Array([0, 255, 128, 10])
  expect(
    await objects.put(
      key,
      bytes,
      'application/octet-stream',
      AbortSignal.timeout(5000),
    ),
  ).toEqual({ byteLength: 4, sha256: sha256(bytes) })
  expect(await objects.read(key, 4, AbortSignal.timeout(5000))).toEqual(bytes)

  const oversized = await objects
    .read(key, 3, AbortSignal.timeout(5000))
    .catch((cause: unknown) => cause)
  expect(oversized).toBeInstanceOf(Error)
  expect(oversized instanceof Error && oversized.message).toBe(
    'Object byte limit exceeded',
  )
  const conflicting = await objects
    .put(key, bytes, 'application/octet-stream', AbortSignal.timeout(5000))
    .catch((cause: unknown) => cause)
  expect(conflicting).toBeInstanceOf(Error)

  const denied = connectObjects({
    ...connection,
    secretAccessKey: 'incorrect-secret',
  })
  try {
    const unauthorized = await denied
      .read(key, 4, AbortSignal.timeout(5000))
      .catch((cause: unknown) => cause)
    expect(unauthorized).toBeInstanceOf(Error)
  } finally {
    denied.close()
  }
  const abortedKey = `assets/uploads/${crypto.randomUUID()}/${crypto.randomUUID()}`
  const aborted = await objects
    .put(abortedKey, bytes, 'application/octet-stream', AbortSignal.abort())
    .catch((cause: unknown) => cause)
  expect(aborted).toBeInstanceOf(Error)
  const absent = await objects
    .read(abortedKey, 4, AbortSignal.timeout(5000))
    .catch((cause: unknown) => cause)
  expect(absent).toBeInstanceOf(Error)

  const client = new S3Client({
    endpoint,
    region: connection.region,
    credentials: {
      accessKeyId: connection.accessKeyID,
      secretAccessKey: connection.secretAccessKey,
    },
    forcePathStyle: true,
    maxAttempts: 1,
  })
  try {
    const deletion = await client
      .send(new DeleteObjectCommand({ Bucket: connection.bucket, Key: key }), {
        abortSignal: AbortSignal.timeout(5000),
      })
      .catch((cause: unknown) => cause)
    expect(deletion).toBeInstanceOf(Error)
    expect(await objects.read(key, 4, AbortSignal.timeout(5000))).toEqual(bytes)
  } finally {
    client.destroy()
  }
})
