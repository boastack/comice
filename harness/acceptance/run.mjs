/**
 * node harness/acceptance/run.mjs [projects…] [--only=ids] [--out=dir]
 *
 * Runs every spec example (example.html) in real browsers and checks each
 * one does what its card says. Projects: chromium webkit firefox iphone
 * pixel (default: all). iphone and pixel emulate phones with touch, where
 * hover becomes a tap. Needs `pnpm build` and the server:
 * `bun harness/acceptance/serve.ts` (port 8750, or ACCEPTANCE_URL).
 *
 * Prints one line per example per project, writes report.json and a
 * screenshot of every example to --out (default harness/acceptance/out).
 */

import { chromium, devices, firefox, webkit } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const option = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1]
const base = process.env.ACCEPTANCE_URL ?? 'http://localhost:8750'
const out = option('out') ?? join(here, 'out')

const PROJECTS = {
  chromium: { engine: chromium, context: { viewport: { width: 900, height: 800 } } },
  webkit: { engine: webkit, context: { viewport: { width: 900, height: 800 } } },
  firefox: { engine: firefox, context: { viewport: { width: 900, height: 800 } } },
  iphone: { engine: webkit, context: devices['iPhone 15'] },
  pixel: { engine: chromium, context: devices['Pixel 7'] },
}
const projects = args.filter((a) => !a.startsWith('--'))
const selected = projects.length ? projects : Object.keys(PROJECTS)
const only = option('only')?.split(',')

const IDS = ['0', '1', '4', '5a', '5b', '5c', '6a', '6b', '7', '8', '9', '10', '11', '13a', '13b', '14']

// ── helpers, run against one example page ─────────────────────────────────

const wait = (page, ms) => page.waitForTimeout(ms)
const handles = (page, fn) => page.evaluate(fn)
/** Hover with a mouse, or tap on a touch device. */
async function point(page, selector, touch) {
  const box = await page.locator(selector).first().boundingBox()
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  if (touch) await page.touchscreen.tap(x, y)
  else await page.mouse.move(x, y, { steps: 6 })
}
/** A horizontal swipe across `selector` by `dx` px. Chromium gets real
 *  touch input (its DevTools protocol), so the browser makes genuine touch
 *  pointers and applies touch-action; Playwright can't drag a finger in
 *  WebKit, so there it's a pointer drag. */
async function swipe(page, selector, dx) {
  const box = await page.locator(selector).first().boundingBox()
  const y = box.y + box.height / 2
  const x0 = box.x + box.width * (dx < 0 ? 0.8 : 0.2)
  const steps = 12
  if (page.context().browser().browserType().name() === 'chromium') {
    const cdp = await page.context().newCDPSession(page)
    const touch = (type, x) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] })
    await touch('touchStart', x0)
    for (let i = 1; i <= steps; i++) {
      await touch('touchMove', x0 + (dx * i) / steps)
      await page.waitForTimeout(16)
    }
    await touch('touchEnd', x0 + dx)
    return
  }
  await page.mouse.move(x0, y)
  await page.mouse.down()
  for (let i = 1; i <= steps; i++) await page.mouse.move(x0 + (dx * i) / steps, y)
  await page.mouse.up()
}

async function scrollTo(page, selector, block = 'center') {
  await page.evaluate(([s, b]) => document.querySelector(s).scrollIntoView({ block: b }), [selector, block])
}
/** Whether `plugin` reports ready within 6s — the first frame of a heavy
 *  effect (120,000 particles) comes later on a loaded machine. */
async function readyFor(page, plugin) {
  try {
    await page.waitForFunction((p) => window.__events.some((e) => e.type === 'ready' && e.plugin === p), plugin, { timeout: 6000 })
    return true
  } catch {
    return false
  }
}

/** Each returns a list of what didn't hold (empty: the example works). */
const CHECKS = {
  async 0(page) {
    const fails = []
    // From idle, 'active' is not a legal jump: refused, "same rules apply".
    if ((await handles(page, () => __handles[0].state)) !== 'idle') fails.push('a forced idle -> active should be refused')
    await handles(page, () => {
      const first = __handles[0].handles[0]
      first.transition('entering')
      first.transition('active')
    })
    await wait(page, 100)
    const opacity = await page.evaluate(() => [...document.querySelectorAll('.project')].map((el) => el.style.opacity))
    if (opacity[0] !== '' || Math.abs(Number(opacity[1]) - 0.4) > 0.01) fails.push(`entering -> active should dim the peers to 0.4: ${opacity}`)
    return fails
  },
  async 1(page, { touch }) {
    const fails = []
    await point(page, '.card', touch)
    await wait(page, 800)
    const state = await handles(page, () => __handles[0].handles[0].state)
    if (state !== 'active') fails.push(`hovering a .card should make it active, got ${state}`)
    await scrollTo(page, '.hero')
    await wait(page, 600)
    const progress = await handles(page, () => __handles[1].progress)
    if (!(progress > 0)) fails.push(`scrolling to .hero should drive morph, progress ${progress}`)
    return fails
  },
  async 4(page, { result }) {
    const fails = []
    if (!(await readyFor(page, 'morph'))) fails.push('morph never reported ready')
    await page.evaluate(() => scrollTo(0, document.body.scrollHeight * 0.18))
    await wait(page, 500)
    const progress = await handles(page, () => __handles[0].progress)
    if (!(progress > 0.05 && progress < 0.95)) fails.push(`mid-scroll should be mid-collapse, progress ${progress}`)
    return fails
  },
  async '5a'(page) {
    const fails = []
    const before = await handles(page, () => __handles[0].handles.map((h) => h.state))
    if (before.some((s) => s !== 'idle')) fails.push(`below the fold the grid should wait: ${before}`)
    await scrollTo(page, '.grid')
    await wait(page, 2000)
    const after = await handles(page, () => __handles[0].handles.map((h) => h.state))
    if (after.some((s) => s !== 'active')) fails.push(`scrolled in, every figure should open: ${after}`)
    return fails
  },
  async '5b'(page, { result, touch }) {
    await point(page, '.image', touch)
    await wait(page, 400)
    return (await readyFor(page, 'reveal')) ? [] : ['the cursor mask never reported ready']
  },
  async '5c'(page, { result }) {
    await wait(page, 1500)
    const fails = []
    if (!(await readyFor(page, 'reveal'))) fails.push('the image mask never reported ready')
    if ((await handles(page, () => __handles[0].state)) !== 'active') fails.push('in view with no driver, it should play itself')
    return fails
  },
  async '6a'(page, { result }) {
    const fails = []
    if (!(await readyFor(page, 'dissolve'))) fails.push('dissolve never reported ready')
    await scrollTo(page, '#gallery') // centred: half way through
    await wait(page, 500)
    const progress = await handles(page, () => __handles[0].progress)
    if (!(progress > 0 && progress < 1)) fails.push(`mid-scroll should be mid-gallery, progress ${progress}`)
    return fails
  },
  async '6b'(page, { result }) {
    await handles(page, () => __handles[0].set({ progress: 0.5 }))
    await wait(page, 200)
    return (await readyFor(page, 'dissolve')) ? [] : ['dissolve never reported ready']
  },
  async 7(page, { touch }) {
    const fails = []
    if (!touch) {
      // As a keyboard user: Tab reaches the active slide (roving tabindex).
      await page.keyboard.press('Tab')
      await page.keyboard.press('ArrowRight')
      await wait(page, 800)
      const meta = await page.textContent('#meta')
      if (meta !== 'Slide 2') fails.push(`ArrowRight should step to slide 2 and call onActive, meta says "${meta}"`)
    }
    const before = await page.textContent('#meta')
    // A swipe on a phone, a mouse drag on desktop (images in the rail: the
    // browser's own image drag must not swallow it).
    await swipe(page, '#rail', -260)
    await wait(page, 1200)
    const after = await page.textContent('#meta')
    if (after === before) fails.push(`dragging the rail should move it and call onActive, meta stayed "${after}"`)
    return fails
  },
  async 8(page, { touch }) {
    const fails = []
    await point(page, '.project:nth-child(2)', touch)
    await wait(page, 900)
    const [first, second] = await page.evaluate(() => [...document.querySelectorAll('.project')].map((el) => ({ opacity: el.style.opacity, filter: el.style.filter, meta: el.querySelector('.meta').style.visibility })))
    if (Math.abs(Number(first.opacity) - 0.4) > 0.02 || !first.filter.includes('blur(4px)')) fails.push(`peers should dim to 0.4 and blur 4px: ${JSON.stringify(first)}`)
    if (second.meta !== 'visible') fails.push('the hovered project should reveal its .meta')
    return fails
  },
  async 9(page, { result, touch }) {
    await point(page, '.image', touch)
    await wait(page, 400)
    return (await readyFor(page, 'distort')) ? [] : ['distort never reported ready']
  },
  async 10(page) {
    await wait(page, 1200)
    const value = await page.evaluate(() => getComputedStyle(document.getElementById('reel')).getPropertyValue('--aura-color-0'))
    return value.startsWith('rgb') ? [] : [`aura should write --aura-color-0, got "${value}"`]
  },
  async 11(page) {
    const fails = []
    await page.evaluate(() => (document.querySelector('.project-name').textContent = 'Basalt'))
    await wait(page, 150)
    const mid = await page.evaluate(() => ({ melting: document.querySelector('.project-name').hasAttribute('data-comice-melt'), text: document.querySelector('.project-name').textContent }))
    if (!mid.melting) fails.push('changing the text should melt')
    if (mid.text !== 'Basalt') fails.push(`mid-melt, textContent should be the real text, got "${mid.text}"`)
    await wait(page, 900)
    if (await page.evaluate(() => document.querySelector('.project-name').hasAttribute('data-comice-melt'))) fails.push('the melt should end')
    await page.evaluate(() => (document.querySelector('.project-name').textContent = 'Basalt'))
    await wait(page, 100)
    if (await page.evaluate(() => document.querySelector('.project-name').hasAttribute('data-comice-melt'))) fails.push('hold: the same text again should stay still')
    return fails
  },
  async '13a'(page, { result }) {
    await page.evaluate(() => scrollTo(0, 450))
    await wait(page, 1200)
    return (await readyFor(page, 'particles')) ? [] : ['particles never reported ready']
  },
  async '13b'(page, { result }) {
    await page.evaluate(() => scrollTo(0, 450))
    await wait(page, 800)
    return (await readyFor(page, 'particles')) ? [] : ['particles never reported ready']
  },
  async 14(page, { result }) {
    const fails = []
    await page.click('#play')
    await wait(page, 1500)
    for (const plugin of ['distort', 'aura', 'color']) if (!(await readyFor(page, plugin))) fails.push(`${plugin} never reported ready`)
    const glow = await page.evaluate(() => document.querySelector('.hero-b').previousElementSibling?.style.opacity)
    if (!(Number(glow) < 1)) fails.push(`energy should drive aura's intensity (glow opacity ${glow})`)
    return fails
  },
}

// ── run ────────────────────────────────────────────────────────────────────

const report = {}
let failures = 0
for (const name of selected) {
  const project = PROJECTS[name]
  if (!project) throw new Error(`Unknown project "${name}". Choose from: ${Object.keys(PROJECTS).join(' ')}`)
  const browser = await project.engine.launch({
    args: name === 'chromium' || name === 'pixel' ? ['--autoplay-policy=no-user-gesture-required'] : [],
    firefoxUserPrefs: project.engine === firefox ? { 'media.autoplay.default': 0 } : undefined,
  })
  const context = await browser.newContext(project.context)
  const touch = !!project.context.hasTouch
  mkdirSync(join(out, name), { recursive: true })
  report[name] = {}
  for (const id of IDS.filter((i) => !only || only.includes(i))) {
    const page = await context.newPage()
    const consoleErrors = []
    page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()))
    let fails = []
    try {
      await page.goto(`${base}/harness/acceptance/example.html?id=${id}`)
      await page.waitForFunction(() => window.acceptance?.done, null, { timeout: 15000 })
      await wait(page, 600)
      const result = await page.evaluate(() => window.acceptance)
      fails = await CHECKS[id](page, { result, touch })
      const final = await page.evaluate(() => window.acceptance)
      fails.push(...final.errors.map((e) => `error: ${e}`))
      fails.push(...final.events.filter((e) => e.type === 'error').map((e) => `${e.plugin} error: ${e.message}`))
      fails.push(...consoleErrors.map((e) => `console: ${e}`))
      await page.screenshot({ path: join(out, name, `${id}.png`) })
    } catch (err) {
      fails.push(`crashed: ${err.message.split('\n')[0]}`)
    }
    report[name][id] = fails
    failures += fails.length ? 1 : 0
    console.log(`${fails.length ? 'FAIL' : 'ok  '} ${name.padEnd(8)} ${id.padEnd(4)} ${fails.join(' | ')}`)
    await page.close()
  }
  await browser.close()
}
writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2))
console.log(failures ? `\n${failures} failing` : '\nall passing')
process.exitCode = failures ? 1 : 0
