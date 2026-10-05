export default async (page) => {
  const check = (condition, message) => {
    if (!condition) throw new Error(message)
  }
  const origin = new URL(page.url()).origin
  const state = async () =>
    await (await page.request.get(`${origin}/fixture/state`)).json()
  await page.getByLabel('Create Chat', { exact: true }).fill('Reload-safe Chat')
  await page.getByRole('button', { name: 'Create Chat', exact: true }).click()
  await page.getByRole('button', { name: 'Retry create Chat' }).waitFor()
  await page.reload()
  check(
    (await page.getByLabel('Create Chat', { exact: true }).inputValue()) ===
      'Reload-safe Chat',
    'creation title lost on reload',
  )
  await page.getByRole('button', { name: 'Create Chat', exact: true }).click()
  await page
    .getByRole('heading', { name: 'Reload-safe Chat', exact: true })
    .waitFor()
  await page.getByLabel('Upload file').setInputFiles({
    name: 'scene é.png',
    mimeType: 'image/png',
    buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]),
  })
  await page.getByRole('button', { name: 'Retry same file' }).waitFor()
  await page.reload()
  await page.getByRole('button', { name: 'Retry same file' }).click()
  await page
    .getByRole('button', { name: 'Retry same file' })
    .waitFor({ state: 'hidden' })
  await page.getByLabel('Attach scene é.png').check()
  await page
    .getByLabel('Describe your video')
    .fill('Preserve this exact message')
  await page.getByRole('button', { name: 'Send message ↗' }).click()
  await page.getByRole('button', { name: 'Retry same message' }).waitFor()
  await page.getByRole('button', { name: 'Fixture Chat', exact: true }).click()
  await page
    .getByRole('button', { name: 'Retry same message' })
    .waitFor({ state: 'hidden' })
  await page
    .getByRole('button', { name: 'Reload-safe Chat', exact: true })
    .click()
  await page.getByRole('button', { name: 'Retry same message' }).waitFor()
  await page.reload()
  await page.getByRole('button', { name: 'Retry same message' }).click()
  await page.getByRole('button', { name: 'Cancel run', exact: true }).waitFor()
  const running = await state()
  const created = running.attempts.find(
    (attempt) => attempt.operation === 'create',
  )
  const cancelKey = `frame:intent:alice:cancel:${created.body.threadID}:${running.activeRuns[0].runID}`
  const corruptCancel = '{unreadable cancellation'
  await page.evaluate(({ key, bytes }) => localStorage.setItem(key, bytes), {
    key: cancelKey,
    bytes: corruptCancel,
  })
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.getByRole('button', { name: 'Cancel run', exact: true }).click()
    await page
      .getByText(
        'Saved pending request could not be decoded. Check Chat history before clearing browser data.',
        { exact: true },
      )
      .waitFor()
    check(
      (await state()).attempts.every((entry) => entry.operation !== 'cancel'),
      'corrupt cancellation dispatched HTTP',
    )
    check(
      (await page.evaluate((key) => localStorage.getItem(key), cancelKey)) ===
        corruptCancel,
      'corrupt cancellation bytes or identity were replaced',
    )
    if (attempt === 0) await page.reload()
  }
  // Test-only operator action after asserting evidence was preserved twice.
  await page.evaluate((key) => localStorage.removeItem(key), cancelKey)
  await page.getByRole('button', { name: 'Cancel run', exact: true }).click()
  await page.getByRole('button', { name: 'Retry cancellation' }).waitFor()
  await page.reload()
  await page.getByRole('button', { name: 'Cancel run', exact: true }).click()
  await page.getByText('Waiting for actual stop…', { exact: true }).waitFor()
  const proof = await state()
  for (const operation of ['create', 'upload', 'message', 'cancel']) {
    const writes = proof.attempts.filter(
      (attempt) => attempt.operation === operation,
    )
    check(writes.length === 2, `${operation}: expected two explicit attempts`)
    check(
      JSON.stringify(writes[0].body) === JSON.stringify(writes[1].body),
      `${operation}: replay changed frozen intent`,
    )
    check(
      writes.every((attempt) => attempt.cookie),
      `${operation}: cookie missing`,
    )
  }
  const events = proof.attempts.filter(
    (attempt) => attempt.operation === 'events',
  )
  check(
    events.length > 0 &&
      events.every(
        (attempt) =>
          attempt.body.messages.length === 0 && attempt.body.tools.length === 0,
      ),
    'observation leaked model history',
  )
  const downloadPromise = page.waitForEvent('download')
  await page
    .getByRole('link', { name: 'scene é.png', exact: true })
    .first()
    .click()
  const download = await downloadPromise
  check(
    download.suggestedFilename() === 'scene é.png',
    'authorized download filename differs',
  )
  const asset = proof.assets[0]
  const response = await page.request.get(
    `${origin}/api/assets/${asset.asset.assetID}/file`,
  )
  check(
    JSON.stringify([...(await response.body())]) ===
      JSON.stringify(asset.bytes),
    'download bytes differ',
  )
  // Deliver only the authoritative snapshot fact, not an SSE terminal overlay.
  await page.request.post(`${origin}/fixture/fail?reason=interrupted`)
  await page.reload()
  await page
    .getByText(
      'The run was interrupted. Check Chat history and ask the operator to verify the execution environment before retrying.',
      {
        exact: true,
      },
    )
    .waitFor()
  await page.reload()
  await page
    .getByText(
      'The run was interrupted. Check Chat history and ask the operator to verify the execution environment before retrying.',
      {
        exact: true,
      },
    )
    .waitFor()
  await page.getByRole('button', { name: 'Archive Chat', exact: true }).click()
  await page.getByText('Archived — read only.', { exact: false }).waitFor()
  check(
    (await page.getByRole('button', { name: 'Send message ↗' }).count()) === 0,
    'archive still permits writes',
  )
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await page.getByRole('button', { name: 'Sign in with GitHub' }).waitFor()
  check(
    (await page
      .getByText('Preserve this exact message', { exact: true })
      .count()) === 0,
    'logout exposes private transcript',
  )
  await page.request.get(`${origin}/fixture/account?user=bob`)
  await page.goto(origin)
  await page.getByText('bob', { exact: true }).waitFor()
  check(
    (await page
      .getByRole('button', { name: 'Reload-safe Chat', exact: true })
      .count()) === 0,
    'account switch exposes the old Chat list',
  )
  return {
    result: 'PASS',
    explicitReplayOperations: ['create', 'upload', 'message', 'cancel'],
    authenticatedDownloadBytes: asset.bytes.length,
    observationFrames: events.length,
    archiveReadOnly: true,
    logoutPrivateViewCleared: true,
    durableFailureAfterReload: true,
    corruptCancellationBlocksHTTPAfterReload: true,
    proof:
      'Controlled HTTP fixture, real generated SDK and React DOM. No database, S3, OAuth provider, model, or sandbox.',
  }
}
