export default async (page) => {
  const check = (condition, message) => {
    if (!condition) throw new Error(message)
  }
  const origin = new URL(page.url()).origin
  const state = async () =>
    await (await page.request.get(`${origin}/fixture/state`)).json()
  await page.addInitScript(() => {
    const remove = Object.getOwnPropertyDescriptor(
      Storage.prototype,
      'removeItem',
    )?.value
    const discard = Object.getOwnPropertyDescriptor(
      Cache.prototype,
      'delete',
    )?.value
    const match = Object.getOwnPropertyDescriptor(
      Cache.prototype,
      'match',
    )?.value
    if (
      typeof remove !== 'function' ||
      typeof discard !== 'function' ||
      typeof match !== 'function'
    )
      throw new Error('Native browser storage APIs unavailable')
    Cache.prototype.match = function (request, options) {
      if (localStorage.getItem('fixture:restore') === 'fail')
        return Promise.reject(new Error('Private cache restore diagnostic'))
      return Reflect.apply(match, this, [request, options])
    }
    Storage.prototype.removeItem = function (key) {
      if (
        key === 'frame:intent:alice:creation' &&
        localStorage.getItem('fixture:cleanup') === 'creation'
      )
        throw new Error('Private browser cleanup diagnostic')
      return Reflect.apply(remove, this, [key])
    }
    Cache.prototype.delete = function (request, options) {
      if (localStorage.getItem('fixture:cleanup') === 'upload')
        return Promise.reject(new Error('Private cache cleanup diagnostic'))
      return Reflect.apply(discard, this, [request, options])
    }
  })
  await page.reload()
  await page.getByRole('button', { name: 'Fixture Chat', exact: true }).click()
  let refusedID = ''
  await page.route('**/api/threads/*/assets', async (route) => {
    if (route.request().method() !== 'POST') return await route.continue()
    refusedID = route.request().headers()['x-asset-id']
    await route.fulfill({
      status: 415,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Private refusal diagnostic' }),
    })
  })
  await page.locator('input[type="file"]:enabled').waitFor()
  await page.getByLabel('Upload file').setInputFiles({
    name: 'bad.gif',
    mimeType: 'image/gif',
    buffer: Buffer.from([0, 1, 2]),
  })
  await page
    .getByText('File refused by server: bad.gif.', { exact: false })
    .waitFor()
  const forget = page.getByRole('button', {
    name: 'Forget saved upload locally and choose another file',
    exact: true,
  })
  check(await forget.isDisabled(), 'local discard bypassed acknowledgment')
  check(
    await page.getByLabel('Upload file').isDisabled(),
    'refusal silently replaced saved bytes',
  )
  await page.getByRole('checkbox', { name: /I checked Chat history/ }).check()
  await forget.click()
  await forget.waitFor({ state: 'hidden' })
  await page.locator('input[type="file"]:enabled').waitFor()
  await page.unroute('**/api/threads/*/assets')
  await page.evaluate(() => localStorage.setItem('fixture:cleanup', 'upload'))
  const bytes = [137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]
  await page.getByLabel('Upload file').setInputFiles({
    name: 'recovered.png',
    mimeType: 'image/png',
    buffer: Buffer.from(bytes),
  })
  await page
    .getByText('Upload acceptance unknown: recovered.png.', { exact: false })
    .waitFor()
  await page.evaluate(() => localStorage.setItem('fixture:restore', 'fail'))
  await page.reload()
  await page
    .getByText(
      'Browser file storage is unavailable. Uploads require persistent browser storage.',
      { exact: true },
    )
    .waitFor()
  check(
    await page.getByLabel('Upload file').isDisabled(),
    'failed restoration enabled a replacement upload before recovering unknown bytes',
  )
  check(
    (await state()).attempts.filter((attempt) => attempt.operation === 'upload')
      .length === 1,
    'failed restoration dispatched replacement work',
  )
  await page.evaluate(() => localStorage.removeItem('fixture:restore'))
  await page
    .getByRole('button', { name: 'Retry restoring saved uploads', exact: true })
    .click()
  await page
    .getByText('Upload acceptance unknown: recovered.png.', { exact: false })
    .waitFor()
  await page
    .getByRole('button', { name: 'Retry same file', exact: true })
    .click()
  await page
    .getByText(
      'File accepted, but its saved upload could not be removed. Check Chat history before retrying.',
      { exact: true },
    )
    .waitFor()
  await page
    .getByText('File accepted; saved upload retained: recovered.png.', {
      exact: false,
    })
    .waitFor()
  const retained = await page.evaluate(async () => {
    const name = (await caches.keys()).find((key) =>
      key.startsWith('frame:uploads:alice:'),
    )
    const cache = await caches.open(name)
    const keys = await cache.keys()
    const saved = await cache.match(keys[0])
    return {
      count: keys.length,
      bytes: [...new Uint8Array(await saved.arrayBuffer())],
    }
  })
  check(
    retained.count === 1 &&
      JSON.stringify(retained.bytes) === JSON.stringify(bytes),
    'accepted cleanup failure lost retry bytes',
  )
  await page.evaluate(() => localStorage.removeItem('fixture:cleanup'))
  await page
    .getByRole('button', { name: 'Retry same file', exact: true })
    .click()
  await page
    .getByRole('button', { name: 'Retry same file', exact: true })
    .waitFor({ state: 'hidden' })
  const uploads = (await state()).attempts.filter(
    (attempt) => attempt.operation === 'upload',
  )
  check(
    uploads.length === 3 &&
      uploads.every(
        (attempt) =>
          JSON.stringify(attempt.body) === JSON.stringify(uploads[0].body),
      ),
    'unknown or accepted retry changed upload identity or bytes',
  )
  check(
    refusedID && uploads[0].identity !== refusedID,
    'explicit replacement reused refused identity',
  )

  await page.evaluate(() => localStorage.setItem('fixture:cleanup', 'creation'))
  await page
    .getByLabel('Create Chat', { exact: true })
    .fill('Accepted cleanup recovery')
  await page.getByRole('button', { name: 'Create Chat', exact: true }).click()
  await page
    .getByRole('button', { name: 'Retry create Chat', exact: true })
    .click()
  await page
    .getByText(
      'Chat accepted, saved request could not be removed. Check Chat history before retrying.',
      { exact: true },
    )
    .waitFor()
  await page
    .getByRole('heading', { name: 'Accepted cleanup recovery', exact: true })
    .waitFor()
  const frozen = await page.evaluate(() =>
    localStorage.getItem('frame:intent:alice:creation'),
  )
  check(frozen !== null, 'accepted creation cleanup failure lost frozen intent')
  await page.evaluate(() => localStorage.removeItem('fixture:cleanup'))
  await page
    .getByRole('button', { name: 'Retry same accepted Chat', exact: true })
    .click()
  await page.waitForFunction(
    () => localStorage.getItem('frame:intent:alice:creation') === null,
  )
  const creations = (await state()).attempts.filter(
    (attempt) => attempt.operation === 'create',
  )
  check(
    creations.length === 3 &&
      creations.every(
        (attempt) =>
          JSON.stringify(attempt.body) === JSON.stringify(creations[0].body),
      ),
    'accepted creation retry changed frozen intent',
  )
  check(
    !(await page.locator('body').textContent()).includes('Private '),
    'private cleanup or refusal diagnostic reached the DOM',
  )
  return {
    result: 'PASS',
    acknowledgmentGatedLocalReplacement: true,
    failedRestorationBlocksReplacementUntilRetry: true,
    acceptedUploadCleanupRetainsExactRetry: true,
    acceptedCreationCleanupRetainsExactRetry: true,
    proof:
      'Controlled HTTP and browser-storage fault fixtures, real React DOM and generated SDK; no paid providers.',
  }
}
