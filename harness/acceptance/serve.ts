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
    // Byte ranges, which <video> relies on for seeking and looping (Safari will
    // not play video without them). A request without one gets the whole file.
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') ?? '')
    if (range && (range[1] || range[2])) {
      const size = file.size
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]))
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
      if (start >= size || start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
      return new Response(file.slice(start, end + 1), {
        status: 206,
        headers: { 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1), 'Content-Type': file.type, 'Cache-Control': 'no-store' },
      })
    }
    return new Response(file, { headers: { 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' } })
  },
})

console.log(`Comice demo:       http://localhost:${port}/demo/`)
console.log(`Comice acceptance: http://localhost:${port}/harness/acceptance/`)
