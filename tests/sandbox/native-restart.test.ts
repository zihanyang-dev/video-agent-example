import { expect, test } from 'bun:test'
import { E2B, type Sandbox } from 'e2b'

const apiUrl = process.env.E2B_API_URL
const sandboxUrl = process.env.E2B_SANDBOX_URL
const apiKey = process.env.E2B_API_KEY
const phase = process.env.E2B_RESTART_PHASE
if (
  !apiUrl ||
  !sandboxUrl ||
  !apiKey ||
  new URL(apiUrl).hostname !== '127.0.0.1' ||
  new URL(sandboxUrl).hostname !== '127.0.0.1'
)
  throw new Error('Owned local Embed configuration required')
const client = new E2B({
  apiUrl,
  sandboxUrl,
  apiKey,
  retries: 0,
  debug: false,
  requestTimeoutMs: 10000,
})
const statePath = '/tmp/native-restart.json'

test('filesystem-only native state survives a normal whole host restart without continuing old work', async () => {
  if (phase === 'seed') {
    await seed()
    return
  }
  if (phase === 'cleanup') {
    const ownership = process.env.E2B_RESTART_OWNER
    if (!ownership) throw new Error('Explicit test ownership required')
    await cleanup(ownership)
    return
  }
  if (phase !== 'resume') throw new Error('Explicit restart phase required')
  const stored = decodeReference(await Bun.file(statePath).json())
  try {
    // Default restore proves the stored kind itself is filesystem-only.
    const remote = await client.Sandbox.connect(stored.id, {
      timeoutMs: 120000,
    })
    expect(remote.sandboxId).toBe(stored.id)
    expect(await remote.files.read('/proc/sys/kernel/random/boot_id')).not.toBe(
      stored.bootID,
    )
    expect(await remote.files.read('/home/user/restart-chosen/note')).toBe(
      'persistent',
    )
    await Bun.sleep(62000)
    expect(
      (
        await remote.commands.run(
          'test ! -e /home/user/restart-chosen/continued',
        )
      ).exitCode,
    ).toBe(0)
  } finally {
    await cleanup(stored.ownership)
  }
}, 100000)

function decodeReference(stored: unknown) {
  if (
    typeof stored !== 'object' ||
    stored === null ||
    !('id' in stored) ||
    !('ownership' in stored) ||
    !('bootID' in stored) ||
    typeof stored.id !== 'string' ||
    typeof stored.ownership !== 'string' ||
    typeof stored.bootID !== 'string'
  )
    throw new Error('Invalid owned native restart reference')
  return { id: stored.id, ownership: stored.ownership, bootID: stored.bootID }
}

async function seed() {
  const ownership = process.env.E2B_RESTART_OWNER
  if (!ownership) throw new Error('Explicit test ownership required')
  let saved = false
  try {
    const remote = await client.Sandbox.create('base', {
      timeoutMs: 120000,
      lifecycle: { onTimeout: 'kill', autoResume: false },
      metadata: { platform: 'vid-restart-check', ownership },
    })
    await remote.commands.run(
      'mkdir -p /home/user/restart-chosen; printf persistent > /home/user/restart-chosen/note',
    )
    const bootID = await remote.files.read('/proc/sys/kernel/random/boot_id')
    const command = await remote.commands.run(
      'printf started > /home/user/restart-chosen/started; sleep 60; printf unsafe > /home/user/restart-chosen/continued',
      { background: true },
    )
    expect((await remote.commands.run(`kill -0 ${command.pid}`)).exitCode).toBe(
      0,
    )
    await waitForStart(remote)
    expect(await remote.pause({ keepMemory: false })).toBe(true)
    await Bun.write(
      statePath,
      JSON.stringify({ id: remote.sandboxId, ownership, bootID }),
    )
    saved = true
  } finally {
    if (!saved) await cleanup(ownership)
  }
}

async function cleanup(ownership: string) {
  const paginator = client.Sandbox.list({ query: { metadata: { ownership } } })
  while (paginator.hasNext) {
    for (const sandbox of await paginator.nextItems())
      await client.Sandbox.kill(sandbox.sandboxId)
  }
}

async function waitForStart(remote: Sandbox) {
  const deadline = Date.now() + 10000
  while (!(await remote.files.exists('/home/user/restart-chosen/started'))) {
    if (Date.now() > deadline)
      throw new Error('Background command did not start')
    await Bun.sleep(20)
  }
}
