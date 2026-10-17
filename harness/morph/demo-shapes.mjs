import { chromium, webkit, devices } from 'playwright'
let failed = false
const positional = process.argv.slice(2).filter(arg => !arg.startsWith('--'))
const engines = positional[0] ? [positional[0]] : ['chromium', 'webkit', 'iphone']
const mediaMode = process.argv.find(arg => arg.startsWith('--media='))?.split('=')[1] ?? 'video'
if (!['image', 'video'].includes(mediaMode)) throw Error('Choose --media=image or --media=video.')
if (engines.some(name => !['chromium','webkit','iphone'].includes(name))) throw Error('Choose chromium, webkit or iphone.')
for (const name of engines) {
  const browser = await (name === 'chromium' ? chromium : webkit).launch()
  const page = await browser.newPage(name === 'iphone' ? { ...devices['iPhone 15'], deviceScaleFactor: 1 } : { viewport: { width: 1000, height: 800 }, deviceScaleFactor: 1 })
  const errors = []; page.on('pageerror', e => errors.push(e.message))
  await page.goto('http://localhost:8750/demo/morph/')
  await page.waitForFunction(async () => window.__demos?.length === (await import('/demo/morph/examples.js')).examples.length)
  await page.evaluate(async () => (await import('comice')).setAdaptiveQuality(false))
  if (mediaMode === 'image') await page.locator('.media-switch [data-media-mode=image]').click()
  const ids = await page.evaluate(() => window.__demos.map(e => e.demo.id))
  for (const id of ids.filter(id => !positional[1] || id === positional[1])) {
    try {
      await page.evaluate(id => { const s = document.getElementById(id); scrollTo(0, s.offsetTop + (s.offsetHeight - innerHeight) * .5) }, id)
      await page.waitForFunction(id => window.__demos.find(e => e.demo.id === id)?.panel.querySelector('.status').textContent.startsWith('Live'), id, { timeout: 30000 })
      const result = await page.evaluate(async id => {
        const e = window.__demos.find(e => e.demo.id === id)
        const code = e.panel.querySelector('code').textContent
        if (!/^\s*(to|from):/m.test(code) || /(?:"|\b)(?:layout|operation|stagger|thread)"?:/.test(code)) throw Error('Snippet uses retired geometry API')
        e.handle.destroy()
        const core = await import('comice'), { morph } = await import('@comice/morph')
        const run = new (Object.getPrototypeOf(async function(){}).constructor)('comice','scroll','prefersReducedMotion','morph',code.replace(/^import .*$/gm,'')+'\nreturn {handle,effect}')
        const copy = await run(core.comice,core.scroll,core.prefersReducedMotion,morph)
        e.handle=copy.handle;e.effect=copy.effect
        await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Snippet never became ready')),10000);e.handle.on('ready',()=>{clearTimeout(timer);resolve()});e.handle.on('error',(_,event)=>{clearTimeout(timer);reject(event.error)})})
        const canvas=e.media.nextElementSibling,gl=canvas.getContext('webgl2'), areas=[]
        for(const progress of [0,.25,.5,.75,1]){
          e.handle.set(e.effect,{progress})
          const data=new Uint8Array(canvas.width*canvas.height*4);gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,data)
          let area=0;for(let i=3;i<data.length;i+=4)if(data[i]>127)area++
          if(!area)throw Error('Empty silhouette at '+progress);areas.push(area)
          if(gl.getError())throw Error('GPU error at '+progress)
        }
        if(new Set(areas).size<3)throw Error('Shape failed to morph')
        if(document.documentElement.scrollWidth>innerWidth)throw Error('Horizontal overflow')
        e.handle.destroy();e.handle=null;e.effect=null
        if(e.media.style.visibility==='hidden')throw Error('Teardown left hidden media')
        if(e.media.nextElementSibling?.tagName==='CANVAS')throw Error('Teardown left canvas')
        return {areas}
      },id)
      console.log('PASS',name,mediaMode,id,JSON.stringify(result))
    } catch(error){failed=true;console.error('FAIL',name,id,error.message)}
  }
  if(errors.length){failed=true;console.error(name,'page errors',JSON.stringify(errors))}
  await browser.close()
}
process.exitCode=failed?1:0
