import { chromium, webkit } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
const out = new URL('./out/fast-scroll/', import.meta.url)
mkdirSync(out, { recursive: true })
const label = process.env.MORPH_CAPTURE ?? 'after'
for (const name of process.argv.slice(2).length ? process.argv.slice(2) : ['chromium', 'webkit']) {
  const browser = await ({chromium, webkit})[name].launch()
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 }, deviceScaleFactor: 1 })
  const errors = []; page.on('pageerror', e => errors.push(e.message))
  try {
    await page.goto('http://localhost:8750/demo/morph/')
    await page.waitForFunction(() => window.__demos?.length === 24)
    await page.evaluate(async () => (await import('comice')).setAdaptiveQuality(false))
    const records = []
    for (const id of ['hero-merge', 'circles', 'arches', 'deck', 'petals', 'apple']) {
      await page.evaluate(id => { const s = document.getElementById(id); scrollTo(0, s.offsetTop + (s.offsetHeight - innerHeight) * .65) }, id)
      await page.waitForFunction(id => __demos.find(e => e.id === id)?.live, id)
      await page.evaluate(id => { const e = __demos.find(e => e.id === id); e.media.pause(); e.media.currentTime = 1 }, id)
      // Fast wheel reversals exercise the native scroll driver and page-speed bend.
      for (const [i, delta] of [220, -180, 260, -220].entries()) {
        await page.mouse.wheel(0, delta)
        const state = await page.evaluate(async id => {
          await new Promise(requestAnimationFrame)
          await new Promise(requestAnimationFrame)
          const e = __demos.find(e => e.id === id), c = e.media.nextElementSibling
          return {progress:e.effect.params.getParam('progress'),velocity:e.effect.params.getParam('velocity'),media:getComputedStyle(e.media).visibility,canvasCount:e.frame.querySelectorAll('canvas').length, animations:e.media.getAnimations().length+(c?.getAnimations().length??0)}
        }, id)
        records.push({id,delta,...state})
        if (state.canvasCount !== 1) throw Error(`${id}: duplicate render surfaces`)
        if (state.progress > 0 && state.progress < 1 && state.media !== 'hidden') throw Error(`${id}: source media remained under a moving silhouette`)
        if (i === 1 || i === 2) await page.screenshot({path:new URL(`${label}-${name}-${id}-${i}.png`,out).pathname})
      }
      // Hold scroll-speed extremes to inspect each corner without losing the transient to screenshot latency.
      for (const velocity of [-1, 1]) {
        await page.evaluate(({id,velocity}) => { const e=__demos.find(e=>e.id===id); e.handle.set(e.effect,{progress:.98,velocity}) }, {id,velocity})
        await page.screenshot({path:new URL(`${label}-${name}-${id}-v${velocity}.png`,out).pathname})
      }
    }
    await page.goto('http://localhost:8750/harness/morph/fast-scroll.html')
    await page.getByRole('button', {name:'Replay rapid scroll',exact:true}).waitFor()
    await page.waitForFunction(() => !document.querySelector('#run').disabled)
    await page.getByRole('button', {name:'Replay rapid scroll',exact:true}).click()
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Reversing rapidly'))
    await page.screenshot({path:new URL(`${label}-${name}-replay.png`,out).pathname})
    await page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Complete'), null, {timeout:15000})
    console.log('PASS',name,'replay page completed eight seconds of rapid scrolling')
    if(errors.length) throw Error(errors.join('\n'))
    writeFileSync(new URL(`${label}-${name}.json`,out),JSON.stringify(records,null,2))
    console.log('PASS',name,'fast wheel reversals and held speed captures', records.length)
  } finally { await browser.close() }
}
