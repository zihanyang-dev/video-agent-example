import { expect, test } from 'bun:test'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('browser build produces HTML with resolvable bundled JavaScript and CSS assets', async () => {
  const output = await mkdtemp(join(tmpdir(), 'vid-web-build-'))
  try {
    const build = Bun.spawn(
      [
        process.execPath,
        'build',
        new URL('./index.html', import.meta.url).pathname,
        '--outdir',
        output,
        '--target',
        'browser',
        '--minify',
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    const diagnostics = await new Response(build.stderr).text()
    expect(await build.exited).toBe(0)
    expect(diagnostics).toBe('')
    const html = await readFile(join(output, 'index.html'), 'utf8')
    const files = await readdir(output)
    const assets = [...html.matchAll(/(?:src|href)="\.\/([^"?]+)"/g)].map(
      (match) => match[1] ?? '',
    )
    expect(assets.some((asset) => asset?.endsWith('.js'))).toBe(true)
    expect(assets.some((asset) => asset?.endsWith('.css'))).toBe(true)
    for (const asset of assets) {
      expect(files).toContain(asset)
      expect((await readFile(join(output, asset))).length).toBeGreaterThan(0)
    }
    expect(html).toContain('<div id="root"></div>')
    expect(html).not.toContain('./main.ts')
  } finally {
    await rm(output, { recursive: true, force: true })
  }
})
