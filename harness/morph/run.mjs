import { chromium, webkit, devices } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
const base = process.env.ACCEPTANCE_URL ?? 'http://localhost:8750'
const out = new URL('./out/', import.meta.url)
mkdirSync(out, { recursive: true })
let failures = 0
const report = {}
for (const name of process.argv.slice(2).length ? process.argv.slice(2) : ['chromium', 'webkit']) {
  const browser = await ({ chromium, webkit })[name].launch()
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(`${base}/harness/morph/`)
  await page.waitForFunction(() => window.__parity?.done, null, { timeout: 90000 })
  const results = await page.evaluate(() => __parity.results)
  for (const r of results) { console.log(`${r.ok ? 'PASS' : 'FAIL'} ${name} ${r.id} ${r.error ?? `mean=${r.mean.toFixed(4)} mask=${r.maskMean.toFixed(3)} changed=${(r.changed * 100).toFixed(3)}% alpha=${(r.alpha * 100).toFixed(3)}%`}`); if (!r.ok) failures++ }
  await page.screenshot({ path: new URL(`${name}-parity.png`, out).pathname, fullPage: true })
  await page.goto(`${base}/demo/morph/`)
  await page.waitForFunction(() => window.__demos?.length === 24)
  await page.evaluate(async () => (await import('/packages/core/dist/index.js')).setAdaptiveQuality(false))
  const integration = []
  for (const id of ['hero-merge', 'apple', 'africa', 'circles', 'sunflower']) {
    await page.evaluate((id) => { const s = document.getElementById(id); scrollTo(0, s.offsetTop + (s.offsetHeight - innerHeight) * .5) }, id)
    await page.waitForFunction((id) => __demos.find((e) => e.demo.id === id)?.panel.querySelector('.status').textContent.startsWith('Live'), id, { timeout: 15000 })
    // A demo already on screen is Live before this scroll; wait for the scroll driver to report it.
    await page.waitForFunction((id) => Math.abs(__demos.find((e) => e.demo.id === id).handle.progress - .5) < .05, id, { timeout: 15000 })
    const snapshot = await page.evaluate((id) => {
      const e = __demos.find((e) => e.demo.id === id)
      return { id, progress: e.handle.progress, canvasCount: document.querySelectorAll('canvas').length, code: e.panel.querySelector('code').textContent, overflow: document.documentElement.scrollWidth > innerWidth }
    }, id)
    // Demos mount ahead of the viewport and stay a few seconds after leaving it, so several
    // canvases are live at once; the bound is what a leak would blow through.
    const ok = snapshot.progress > .45 && snapshot.progress < .55 && snapshot.canvasCount <= 8 && snapshot.code.includes('morph(') && !snapshot.overflow
    integration.push({ ...snapshot, code: snapshot.code.length, ok }); if (!ok) failures++
    // Execute the code printed under the demo, using its actual imports.
    // This catches drift between a working showcase and a broken copyable snippet.
    await page.evaluate(async (id) => {
      const entry = __demos.find((e) => e.demo.id === id)
      const code = entry.panel.querySelector('code').textContent.replace(/^import .*$/gm, '')
      entry.handle.destroy()
      const core = await import('/packages/core/dist/index.js')
      const { morph } = await import('/packages/morph/dist/index.js')
      const run = new (Object.getPrototypeOf(async function(){}).constructor)('comice', 'scroll', 'prefersReducedMotion', 'morph', code + '\nreturn { handle, effect }')
      const copied = await run(core.comice, core.scroll, core.prefersReducedMotion, morph)
      entry.handle = copied.handle; entry.effect = copied.effect
    }, id)
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name} demo ${id}`)
  }
  await page.evaluate(() => { const e = __demos.find((e) => e.demo.id === 'circles'); e.handle.destroy() })
  if (await page.locator('#circles-media').evaluate((el) => el.style.visibility === 'hidden')) { errors.push('destroy left media hidden'); failures++ }
  await page.screenshot({ path: new URL(`${name}-demo.png`, out).pathname })
  const transparency = await page.evaluate(async () => {
    const { comice } = await import('/packages/core/dist/index.js')
    const { morph } = await import('/packages/morph/dist/index.js')
    const img = new Image(); img.src = '/demo/assets/images/apple.svg'; await img.decode()
    img.style.cssText = 'position:fixed;left:0;top:0;width:256px;height:256px'
    document.body.append(img)
    const effect = morph({ to: { type: 'text', text: 'ACME' } })
    const handle = comice(img).use(effect)
    await new Promise((resolve, reject) => { handle.on('ready', resolve); handle.on('error', (_, event) => reject(event.error)) })
    handle.set(effect, { progress: 0 })
    const canvas = img.nextElementSibling, gl = canvas.getContext('webgl2')
    const outside = new Uint8Array(4), inside = new Uint8Array(4)
    gl.readPixels(Math.round(canvas.width * .2), Math.round(canvas.height * .8), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, outside)
    gl.readPixels(Math.round(canvas.width * .5), Math.round(canvas.height * .5), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, inside)
    const error = gl.getError()
    handle.destroy(); img.remove()
    return { outside: outside[3], inside: inside[3], error }
  })
  if (transparency.outside !== 0 || transparency.inside !== 255 || transparency.error !== 0) { errors.push('liquid mask lost source transparency or reported a GL error'); failures++ }
  console.log(`${transparency.outside === 0 && transparency.inside === 255 && transparency.error === 0 ? 'PASS' : 'FAIL'} ${name} transparent source`)
  const shapes = await page.evaluate(async () => (await import('/harness/morph/shapes.js')).shapeChecks())
  for (const result of shapes) { console.log(`${result.ok ? 'PASS' : 'FAIL'} ${name} ${result.id} ${result.error ?? ''}`); if (!result.ok) failures++ }
  report[name] = { results, integration, transparency, shapes, errors }
  await browser.close()
}
writeFileSync(new URL('report.json', out), JSON.stringify(report, null, 2))
process.exitCode = failures || Object.values(report).some((r) => r.errors.length) ? 1 : 0
