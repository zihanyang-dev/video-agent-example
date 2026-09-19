/**
 * A container on this machine, rented for one turn.
 *
 * The development implementation. It is first not because Docker is the destination, but
 * because it shares nothing with a cloud SDK -- a port that holds both of these holds the
 * cloud ones too, whereas a port shaped around one vendor's client is that vendor wearing a
 * different name (architecture.md §5).
 *
 * The only file allowed to say `docker`.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  toSandbox,
  type ExecOptions,
  type RentSandbox,
  type Sandbox,
  type SandboxRoots,
} from './sandbox'

const SANDBOX_ROOT = '/work'
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

export const rentDockerSandbox: RentSandbox = async (spec): Promise<Sandbox> => {
  const roots: SandboxRoots = {
    host: mkdtempSync(join(tmpdir(), 'vid-turn-')),
    sandbox: SANDBOX_ROOT,
  }

  // Whoever creates something owns cleaning it up, including when the next step is what
  // fails. Nothing returns a handle here, so there is no `destroy` for a caller to call.
  const container = await startContainer(spec.image).catch(async (error: unknown) => {
    await rm(roots.host, { recursive: true, force: true })
    throw error
  })
  await docker(['exec', container, 'mkdir', '-p', SANDBOX_ROOT])

  const inside = toSandbox(roots)

  return {
    roots,
    exec: (command, cwd, options) => runCommand(container, spec.env)(command, inside(cwd), options),
    readFile: async (path) => (await docker(['exec', container, 'cat', inside(path)])).output,
    access: async (path) => {
      const { exitCode } = await docker(['exec', container, 'test', '-r', inside(path)])
      if (exitCode !== 0) throw new Error(`not readable: ${path}`)
    },
    mimeType: async (path) => {
      const quoted = JSON.stringify(inside(path))
      const probe = await docker(['exec', container, 'sh', '-c', `file --mime-type -b ${quoted}`])
      const found = probe.output.toString().trim()
      return IMAGE_TYPES.has(found) ? found : null
    },
    writeFile: async (path, bytes) => {
      const quoted = JSON.stringify(inside(path))
      const written = await docker(['exec', '-i', container, 'sh', '-c', `cat > ${quoted}`], bytes)
      if (written.exitCode !== 0) throw new Error(`write failed: ${path}`)
    },
    mkdir: async (path) => {
      await docker(['exec', container, 'mkdir', '-p', inside(path)])
    },
    list: async () => {
      // Null-separated: a newline in a filename is legal, and an agent that just rendered
      // "shot 2\nfinal.mp4" would otherwise lose the file on the way out.
      const found = await docker(['exec', container, 'find', SANDBOX_ROOT, '-type', 'f', '-print0'])
      return found.output
        .toString()
        .split('\0')
        .filter((path) => path.startsWith(`${SANDBOX_ROOT}/`))
        .map((path) => path.slice(SANDBOX_ROOT.length + 1))
    },
    destroy: async () => {
      await docker(['rm', '-f', container])
      await rm(roots.host, { recursive: true, force: true })
    },
  }
}

const startContainer = async (image: string): Promise<string> => {
  const started = await docker(['run', '-d', '-w', SANDBOX_ROOT, image, 'sleep', 'infinity'])
  const id = started.output.toString().trim()
  if (started.exitCode !== 0 || id === '') {
    throw new Error(`could not start sandbox: ${started.output.toString().trim()}`)
  }
  return id
}

/**
 * A fresh `bash -c` per call, with the environment the spec allows and nothing else. The
 * container and its environment are fixed for the turn, so they are bound once.
 */
const runCommand =
  (container: string, env: Record<string, string>) =>
  (command: string, cwd: string, options: ExecOptions): Promise<{ exitCode: number | null }> => {
    const passed = Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`])
    const argv = ['exec', '-i', '-w', cwd, ...passed, container, 'bash', '-c', command]
    return new Promise((resolve, reject) => {
      const child = spawn('docker', argv, { stdio: ['ignore', 'pipe', 'pipe'] })
      let timedOut = false
      const timer = options.timeout
        ? setTimeout(() => {
            timedOut = true
            child.kill('SIGKILL')
          }, options.timeout * 1000)
        : undefined
      const stop = () => child.kill('SIGKILL')

      child.stdout.on('data', options.onData)
      child.stderr.on('data', options.onData)
      options.signal?.addEventListener('abort', stop, { once: true })
      child.on('error', (error) => {
        if (timer) clearTimeout(timer)
        reject(error)
      })
      child.on('close', (exitCode) => {
        if (timer) clearTimeout(timer)
        options.signal?.removeEventListener('abort', stop)
        if (options.signal?.aborted) reject(new Error('aborted'))
        else if (timedOut) reject(new Error(`timeout:${options.timeout}`))
        else resolve({ exitCode })
      })
    })
  }

const docker = (argv: readonly string[], stdin?: Uint8Array) =>
  new Promise<{ exitCode: number | null; output: Buffer }>((resolve, reject) => {
    const child = spawn('docker', [...argv], {
      stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    })
    const chunks: Buffer[] = []
    const collect = (chunk: Buffer) => chunks.push(chunk)
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.on('error', reject)
    child.on('close', (exitCode) => resolve({ exitCode, output: Buffer.concat(chunks) }))
    if (stdin !== undefined) child.stdin?.end(stdin)
  })
