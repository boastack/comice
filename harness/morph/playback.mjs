import { chromium, webkit, devices } from 'playwright'
import { mkdirSync } from 'node:fs'
mkdirSync(new URL('./out/', import.meta.url), { recursive: true })
const base = process.env.ACCEPTANCE_URL ?? 'http://localhost:8750'
const engines = process.argv[2] ? [process.argv[2]] : ['chromium', 'webkit', 'iphone']
let failed = false
for (const name of engines) {
  if (!['chromium','webkit','iphone'].includes(name)) throw Error('Choose chromium, webkit or iphone.')
  const browser = await (name === 'chromium' ? chromium : webkit).launch()
  const page = await browser.newPage(name === 'iphone' ? { ...devices['iPhone 15'], deviceScaleFactor: 1 } : { viewport: { width: 1000, height: 800 }, deviceScaleFactor: 1 })
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  try {
    await page.goto(`${base}/demo/morph/`)
    await page.waitForFunction(() => window.__demos?.at(-1)?.id === 'name-to-role')
    await page.evaluate(async () => (await import('comice')).setAdaptiveQuality(false))
    for (const id of ['progress-dial', 'name-to-role']) {
      await page.evaluate(id => { const e = __demos.find(e => e.id === id); scrollTo(0, e.section.offsetTop + (e.section.offsetHeight - innerHeight) * .5) }, id)
      await page.waitForFunction(id => { const e = __demos.find(e => e.id === id); return e?.live && e.media instanceof HTMLVideoElement && !e.media.paused }, id)
      const result = await page.evaluate(async id => {
        const e = __demos.find(e => e.id === id), canvas = e.media.nextElementSibling, gl = canvas.getContext('webgl2')
        const original = gl.drawArrays.bind(gl)
        let draws = 0, difference = 0, previous
        const time = e.media.currentTime
        gl.drawArrays = (...args) => {
          original(...args); draws++
          const data = new Uint8Array(canvas.width * 16 * 4)
          gl.readPixels(0, Math.max(0, Math.floor(canvas.height / 2) - 8), canvas.width, 16, gl.RGBA, gl.UNSIGNED_BYTE, data)
          if (previous) for (let i = 0; i < data.length; i += 4) if (data[i+3] > 127 && previous[i+3] > 127) difference += Math.abs(data[i]-previous[i]) + Math.abs(data[i+1]-previous[i+1]) + Math.abs(data[i+2]-previous[i+2])
          previous = data
        }
        try {
          await new Promise(resolve => setTimeout(resolve, 1400))
          return { draws, difference, elapsed: e.media.currentTime - time, paused: e.media.paused }
        } finally { gl.drawArrays = original }
      }, id)
      if (result.paused || result.elapsed <= 0 || result.draws < 3 || result.difference < 100) throw Error(`${id}: playback froze ${JSON.stringify(result)}`)
      console.log('PASS', name, id, JSON.stringify(result))
    }
    const last = page.locator('#name-to-role')
    for (const mode of ['image', 'video', 'image', 'video']) {
      await page.locator(`.media-switch [data-media-mode="${mode}"]`).click()
      await page.waitForFunction(mode => { const e = __demos.at(-1); return e.live && e.mediaMode === mode && (mode === 'image' ? e.media instanceof HTMLImageElement : e.media instanceof HTMLVideoElement && !e.media.paused) }, mode)
      const state = await last.evaluate(section => ({ canvases: section.querySelectorAll('canvas').length, selected: document.querySelectorAll('[data-media-mode][aria-pressed=true]').length, mediaTags: [...document.querySelectorAll('#collection .media')].map(media => media.tagName), heading: !!section.querySelector('.copy') }))
      if (state.canvases !== 1 || state.selected !== 1 || state.heading || state.mediaTags.length !== 25 || state.mediaTags.some(tag => tag !== (mode === 'image' ? 'IMG' : 'VIDEO'))) throw Error('Switch leaked surfaces or restored the heading: ' + JSON.stringify(state))
    }
    console.log('PASS', name, 'global Image/Video switching updates all 25 demos with one active surface')
    await page.locator('#settings-toggle').click()
    await page.locator('#pause').click()
    await page.waitForFunction(() => __demos.at(-1).media.paused)
    await page.locator('#pause').click()
    await page.waitForFunction(() => !__demos.at(-1).media.paused)
    await page.locator('[data-close]').click()
    await page.evaluate(() => { const e = __demos.at(-1); scrollTo(0, e.section.offsetTop + (e.section.offsetHeight - innerHeight) * .98) })
    await page.waitForFunction(() => __demos.at(-1).effect.params.getParam('progress') > .95)
    await page.screenshot({ path: new URL(`./out/${name}-video-text.png`, import.meta.url).pathname })
    console.log('PASS', name, 'global pause and resume')
    await page.locator('.media-switch [data-media-mode=image]').click()
    await page.waitForFunction(() => __demos.at(-1).live && __demos.at(-1).mediaMode === 'image')
    await page.screenshot({ path: new URL(`./out/${name}-image-text.png`, import.meta.url).pathname })
    await page.evaluate(() => document.querySelector('#progress-dial').scrollIntoView())
    await page.waitForFunction(() => __demos[0].live && __demos[0].mediaMode === 'image')
    await page.waitForFunction(() => !__demos.at(-1).handle)
    await page.evaluate(() => { const e = __demos.at(-1); scrollTo(0, e.section.offsetTop + (e.section.offsetHeight - innerHeight) * .98) })
    await page.waitForFunction(() => __demos.at(-1).live && __demos.at(-1).mediaMode === 'image')
    const imageSources = await page.evaluate(() => __demos.map(e => e.media.getAttribute('src')))
    if (imageSources.some(src => !/^\.\.\/assets\/images\/[ab]\.jpg$/.test(src))) throw Error('Image mode did not retain A/B sources after remount')
    console.log('PASS', name, 'Image mode survives offscreen teardown and remount with A/B photographs')
    // Reproduce a browser blocking automatic play on the first attempt.
    await page.addInitScript(() => {
      const play = HTMLMediaElement.prototype.play
      const blocked = new WeakSet()
      HTMLMediaElement.prototype.play = function() {
        if (this.id === 'progress-dial-media' && !blocked.has(this)) { blocked.add(this); return Promise.reject(new DOMException('Autoplay blocked', 'NotAllowedError')) }
        return play.call(this)
      }
    })
    await page.goto(`${base}/demo/morph/`)
    await page.waitForFunction(() => window.__demos?.length > 0)
    await page.evaluate(() => document.querySelector('#progress-dial').scrollIntoView())
    await page.locator('#progress-dial .video-retry').waitFor({ state: 'visible' })
    await page.locator('#progress-dial .video-retry').click()
    await page.waitForFunction(() => { const m = document.querySelector('#progress-dial-media'); return m && !m.paused && document.querySelector('#progress-dial .video-retry').hidden })
    console.log('PASS', name, 'blocked autoplay recovers with Play video')
    if (errors.length) throw Error(errors.join('\n'))
  } catch (error) { failed = true; console.error('FAIL', name, error.message) }
  finally { await browser.close() }
}
process.exitCode = failed ? 1 : 0
