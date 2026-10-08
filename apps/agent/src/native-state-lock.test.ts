import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireNativeStateLock } from './native-state-lock'

async function readReceipt(reader: ReadableStreamDefaultReader<Uint8Array>, receipt: string) {
  const decoder = new TextDecoder()
  let output = ''
  while (!output.includes(receipt)) {
    const chunk = await reader.read()
    if (chunk.done) throw new Error(`Owner exited before receipt: ${receipt}`)
    output += decoder.decode(chunk.value, { stream: true })
  }
}

for (const owner of ['retained', 'discarded', 'failed-close', 'failed-worker'] as const) {
  test(`native state remains physically owned after GC of ${owner} handles`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'owned-native-lock-'))
    const module = new URL('./native-state-lock.ts', import.meta.url).href
    const child = Bun.spawn(
      [
        process.execPath,
        '-e',
        `
    if (${JSON.stringify(owner)} === 'failed-close') {
      const { mock } = await import('bun:test');
      const { mkdir, open } = await import('node:fs/promises');
      mock.module('node:fs/promises', () => ({ mkdir, open: async (...args) => {
        const file = await open(...args);
        file.close = () => Promise.reject(new Error('Controlled close failure'));
        return file;
      } }));
    }
    const { acquireNativeStateLock } = await import(${JSON.stringify(module)});
    let retained;
    let workerReference;
    if (${JSON.stringify(owner)} === 'retained') {
      retained = await acquireNativeStateLock(${JSON.stringify(directory)});
    } else if (${JSON.stringify(owner)} === 'discarded') {
      await (async () => { await acquireNativeStateLock(${JSON.stringify(directory)}); })();
    } else if (${JSON.stringify(owner)} === 'failed-close') {
      await (async () => {
        const lock = await acquireNativeStateLock(${JSON.stringify(directory)});
        const closing = lock.close();
        if (lock.close() !== closing) throw new Error('Close must be idempotent');
        const failure = await closing.catch(error => error);
        if (failure?.message !== 'Controlled close failure') throw new Error('Expected close failure');
      })();
    } else {
      const { WorkerProcess } = await import(${JSON.stringify(new URL('./worker.ts', import.meta.url).href)});
      await (async () => {
        const worker = new WorkerProcess({
          DATABASE_URL: 'postgres://fixture:fixture@127.0.0.1:1/fixture?sslmode=disable',
          REDIS_URL: 'redis://127.0.0.1:1', IO_TIMEOUT_MS: 100,
        });
        workerReference = new WeakRef(worker);
        await worker.connect(${JSON.stringify(directory)}).catch(() => {});
        const failure = await worker.stop().catch(error => error);
        if (!(failure instanceof AggregateError)) throw new Error('Expected failed worker cleanup');
      })();
    }
    await Bun.sleep(20);
    for (let i = 0; i < 20; i++) { Bun.gc(true); await Bun.sleep(20); }
    if (workerReference?.deref()) throw new Error('Failed worker was not collected');
    console.log('held');
    if (retained) {
      await new Response(Bun.stdin.stream()).text();
      await Promise.all([retained.close(), retained.close()]);
      console.log('closed');
    }
    setInterval(() => {}, 10000);
  `,
      ],
      { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    )
    try {
      const reader = child.stdout.getReader()
      await readReceipt(reader, 'held\n')
      expect(child.exitCode).toBeNull()
      let admission: unknown
      try {
        const unexpected = await acquireNativeStateLock(directory)
        await unexpected.close()
        admission = 'acquired'
      } catch (error) {
        admission = error
      }
      expect(admission).toEqual(new Error('Native session storage already has a physical owner'))
      if (owner === 'retained') {
        await child.stdin.end()
        await readReceipt(reader, 'closed\n')
        expect(child.exitCode).toBeNull()
        const released = await acquireNativeStateLock(directory)
        await released.close()
      }
      reader.releaseLock()
      child.kill('SIGKILL')
      await child.exited
      expect(child.signalCode).toBe('SIGKILL')
      const replacement = await acquireNativeStateLock(directory)
      await replacement.close()
      const next = await acquireNativeStateLock(directory)
      await next.close()
    } finally {
      if (child.exitCode === null) {
        child.kill('SIGKILL')
        await child.exited
      }
      await rm(directory, { recursive: true, force: true })
    }
  }, 15000)
}

test('successful close releases its descriptor and closes its native library exactly once', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'owned-native-lock-release-'))
  const module = new URL('./native-state-lock.ts', import.meta.url).href
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      `
    const { mock } = await import('bun:test');
    const { mkdir, open } = await import('node:fs/promises');
    const { dlopen } = await import('bun:ffi');
    const { fstatSync } = await import('node:fs');
    let descriptor;
    let closed = 0;
    mock.module('node:fs/promises', () => ({ mkdir, open: async (...args) => {
      const file = await open(...args);
      descriptor = file.fd;
      return file;
    } }));
    mock.module('bun:ffi', () => ({ dlopen(...args) {
      const library = dlopen(...args);
      return { symbols: library.symbols, close() { closed++; library.close(); } };
    } }));
    const { acquireNativeStateLock } = await import(${JSON.stringify(module)});
    await (async () => {
      const lock = await acquireNativeStateLock(${JSON.stringify(directory)});
      const closing = lock.close();
      if (lock.close() !== closing) throw new Error('Close must be idempotent');
      await closing;
    })();
    await Bun.sleep(20);
    for (let i = 0; i < 20; i++) { Bun.gc(true); await Bun.sleep(20); }
    if (descriptor === undefined) throw new Error('File descriptor was not observed');
    const result = (() => { try { fstatSync(descriptor); return 'open'; } catch (error) { return error.code; } })();
    console.log(JSON.stringify({ descriptor: result, closed }));
  `,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  try {
    const output = await new Response(child.stdout).text()
    expect(await child.exited).toBe(0)
    expect(JSON.parse(output)).toEqual({ descriptor: 'EBADF', closed: 1 })
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGKILL')
      await child.exited
    }
    await rm(directory, { recursive: true, force: true })
  }
})

test('failed lock-file open closes its already acquired native library', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'owned-native-lock-open-'))
  const module = new URL('./native-state-lock.ts', import.meta.url).href
  await mkdir(join(directory, 'owner.lock'))
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      `
    const { mock } = await import('bun:test');
    const { dlopen } = await import('bun:ffi');
    let closed = 0;
    mock.module('bun:ffi', () => ({ dlopen(...args) {
      const library = dlopen(...args);
      return { symbols: library.symbols, close() { closed++; library.close(); } };
    } }));
    const { acquireNativeStateLock } = await import(${JSON.stringify(module)});
    const error = await acquireNativeStateLock(${JSON.stringify(directory)}).catch(error => error);
    console.log(JSON.stringify({ code: error.code, closed }));
  `,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  try {
    const output = await new Response(child.stdout).text()
    expect(await child.exited).toBe(0)
    expect(JSON.parse(output)).toEqual({ code: 'EISDIR', closed: 1 })
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGKILL')
      await child.exited
    }
    await rm(directory, { recursive: true, force: true })
  }
})
