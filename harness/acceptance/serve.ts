/**
 * bun harness/acceptance/serve.ts [port]
 *
 * Serves the repository (the acceptance pages load the built packages by
 * path), plus the root-relative assets the spec's examples name as
 * written: '/founder.jpg' and '/wave.png'. Run `pnpm build` first.
 */

import { join, normalize } from 'node:path'

const root = join(import.meta.dir, '..', '..')
const assets = join(import.meta.dir, 'assets')
const aliases: Record<string, string> = {
  '/founder.jpg': join(assets, 'founder.png'),
  '/wave.png': join(assets, 'wave.png'),
}
const port = Number(process.argv[2] ?? 8750)

Bun.serve({
  port,
  async fetch(request) {
    const { pathname } = new URL(request.url)
    if (pathname === '/') return Response.redirect('/harness/acceptance/', 302)
    let path = aliases[pathname] ?? normalize(join(root, decodeURIComponent(pathname)))
    if (!path.startsWith(root)) return new Response('Not found', { status: 404 })
    if (pathname.endsWith('/')) path = join(path, 'index.html')
    const file = Bun.file(path)
    if (!(await file.exists())) return new Response('Not found', { status: 404 })
    return new Response(file, { headers: { 'Cache-Control': 'no-store' } })
  },
})

console.log(`Comice demo:       http://localhost:${port}/demo/`)
console.log(`Comice acceptance: http://localhost:${port}/harness/acceptance/`)
