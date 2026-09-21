/**
 * A container on this machine, rented for one turn.
 *
 * The development implementation. It is first not because Docker is the destination, but
 * because it shares nothing with a cloud SDK -- a port that holds both of these holds the
 * cloud ones too, whereas a port shaped around one vendor's client is that vendor wearing a
 * different name (architecture.md §8).
 *
 * Docker configuration is supplied by the composition root.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  toSandbox,
  type ExecOptions,
  type SandboxSpec,
  type Sandbox,
  type SandboxRoots,
} from '../../application/ports/sandbox'

const SANDBOX_ROOT = '/work'

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

export const rentDockerSandbox = async (
  spec: SandboxSpec,
  resolvers: readonly string[],
): Promise<Sandbox> => {
  const roots: SandboxRoots = {
    host: mkdtempSync(join(tmpdir(), 'vid-turn-')),
    sandbox: SANDBOX_ROOT,
  }

  // Whoever creates something owns cleaning it up, including when the next step is what
  // fails. Nothing returns a handle here, so there is no `destroy` for a caller to call.
  const containerID = await startContainer(spec.image, spec.network, resolvers).catch(
    async (error: unknown) => {
      await rm(roots.host, { recursive: true, force: true })
      throw error
    },
  )

  return attachContainer({ containerID, roots, env: spec.env })
}

const attachContainer = ({
  containerID,
  roots,
  env,
}: {
  containerID: string
  roots: SandboxRoots
  env: Record<string, string>
}): Sandbox => {
  const sandboxPath = toSandbox(roots)
  const execute = runCommand(containerID, env)

  return {
    roots,
    exec: (command, cwd, options) => execute(command, sandboxPath(cwd), options),
    readFile: async (path) => {
      const read = await invokeDocker(['exec', containerID, 'cat', '--', sandboxPath(path)])
      if (read.exitCode !== 0)
        throw new Error(`could not read ${path}: ${read.output.toString().trim()}`)
      return read.output
    },
    access: async (path) => {
      const { exitCode } = await invokeDocker([
        'exec',
        containerID,
        'test',
        '-r',
        sandboxPath(path),
      ])
      if (exitCode !== 0) throw new Error(`not readable: ${path}`)
    },
    mimeType: async (path) => {
      const probe = await invokeDocker([
        'exec',
        containerID,
        'file',
        '--mime-type',
        '-b',
        '--',
        sandboxPath(path),
      ])
      const found = probe.output.toString().trim()
      return IMAGE_TYPES.has(found) ? found : null
    },
    writeFile: (path, bytes) => writeContainerFile(containerID, sandboxPath(path), bytes),
    mkdir: async (path) => {
      await invokeDocker(['exec', containerID, 'mkdir', '-p', sandboxPath(path)])
    },
    list: () => listContainerFiles(containerID),
    destroy: async () => {
      await invokeDocker(['rm', '-f', containerID])
      await rm(roots.host, { recursive: true, force: true })
    },
  }
}

const startContainer = async (
  image: string,
  network: string,
  resolvers: readonly string[],
): Promise<string> => {
  const started = await invokeDocker([
    'run',
    '-d',
    '-w',
    SANDBOX_ROOT,
    '--network',
    network,
    ...resolvers.flatMap((resolver) => ['--dns', resolver]),
    image,
    'sleep',
    'infinity',
  ])
  const containerID = started.output.toString().trim()
  if (started.exitCode !== 0 || containerID === '') {
    throw new Error(`could not start sandbox: ${started.output.toString().trim()}`)
  }
  return containerID
}

/**
 * A fresh `bash -c` per call, with the environment the spec allows and nothing else. The
 * container and its environment are fixed for the turn, so they are bound once.
 */
const runCommand =
  (containerID: string, env: Record<string, string>) =>
  (command: string, cwd: string, options: ExecOptions): Promise<{ exitCode: number | null }> => {
    const environmentArguments = Object.entries(env).flatMap(([key, value]) => [
      '-e',
      `${key}=${value}`,
    ])
    const argv = [
      'exec',
      '-i',
      '-w',
      cwd,
      ...environmentArguments,
      containerID,
      'bash',
      '-c',
      command,
    ]
    return new Promise((resolve, reject) => {
      const child = spawn('docker', argv, { stdio: ['ignore', 'pipe', 'pipe'] })
      let hasTimedOut = false
      const timer = options.timeout
        ? setTimeout(() => {
            hasTimedOut = true
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
        else if (hasTimedOut) reject(new Error(`timeout:${options.timeout}`))
        else resolve({ exitCode })
      })
    })
  }

const invokeDocker = (argv: readonly string[], stdin?: Uint8Array) =>
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

const writeContainerFile = async (
  containerID: string,
  path: string,
  bytes: Uint8Array,
): Promise<void> => {
  const written = await invokeDocker(
    ['exec', '-i', containerID, 'sh', '-c', 'cat > "$1"', '--', path],
    bytes,
  )
  // Say what the shell said. "write failed" alone sends whoever reads it looking in the
  // wrong place -- a missing parent directory and a full disk read identically.
  if (written.exitCode !== 0) {
    throw new Error(`could not write ${path}: ${written.output.toString().trim()}`)
  }
}

const listContainerFiles = async (containerID: string): Promise<string[]> => {
  // Newlines are valid inside filenames, so snapshots need the null-delimited listing.
  const listing = await invokeDocker([
    'exec',
    containerID,
    'find',
    SANDBOX_ROOT,
    '-type',
    'f',
    '-print0',
  ])
  return listing.output
    .toString()
    .split('\0')
    .filter((path) => path.startsWith(`${SANDBOX_ROOT}/`))
    .map((path) => path.slice(SANDBOX_ROOT.length + 1))
}
