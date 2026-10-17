import { chromium, webkit, devices } from 'playwright'
const cases = [
  'polygon(50% 100%, 0% 25%, 15% 10%, 35% 0%, 65% 0%, 85% 10%, 100% 25%)',
  'polygon(evenodd, 0% 0%, 100% 0%, 100% 100%, 0% 100%, 0% 0%, 30% 30%, 30% 70%, 70% 70%, 70% 30%, 30% 30%, 0% 0%)',
  'circle(35% at 25% 60%)', 'circle(at center)', 'circle(farthest-side at left top)',
  'ellipse(40% 25% at right center)', 'ellipse()', 'ellipse(closest-side closest-side at 70% 40%)',
  'inset(12px 8% 25px round 25px 50px 10px 30px / 10px 20px 30px 40px)',
  'inset(70% 0% 60% 0%)', 'inset(0 round 80%)',
  'inset(calc(10% + 12px) calc(100% - 370px) 20px 15px round 16px)',
  `path(evenodd, 'M10 10H390V190H10Z M140 60H260V140H140Z')`,
  `path('M20 180 Q200 -150 380 180 C280 90 120 90 20 180Z')`,
  'rect(10px auto 90% 15px round 16px)', 'xywh(10% 20px 70% 80% round 20px)',
  'polygon(0% 0%, 100% 0%, 50% 100%) border-box',
  `path('M10 100A90 90 0 01190 100A90 90 0 0110 100Z')`,
]
let failed = false
for (const name of ['chromium', 'webkit', 'iphone']) {
  const browser = await (name === 'chromium' ? chromium : webkit).launch()
  const page = await browser.newPage(name === 'iphone' ? { ...devices['iPhone 15'], deviceScaleFactor: 1, viewport: { width: 420, height: 852 } } : { viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 })
  page.on('pageerror', e => { failed = true; console.error(name, e.message) })
  await page.goto('http://localhost:8750/harness/morph/clip-path.html')
  await page.evaluate(async () => {
    const core = await import('comice'); core.setAdaptiveQuality(false)
    const { morph } = await import('@comice/morph')
    window.mount = async (options, progress = 1, width = 400, height = 200, style = '', mediaKind = 'image') => {
      const texture = document.createElement('canvas'); texture.width = texture.height = 8
      const ctx = texture.getContext('2d'); ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 8, 8)
      const media = mediaKind === 'video' ? document.createElement('video') : new Image()
      if (mediaKind === 'video') {
        media.muted = true; media.playsInline = true; media.preload = 'auto'
        await new Promise((resolve, reject) => {
          media.addEventListener('loadeddata', resolve, { once: true })
          media.addEventListener('error', () => reject(Error('Video fixture failed to load')), { once: true })
          media.src = '/demo/assets/video/a.mp4'
        })
      } else { media.src = texture.toDataURL(); await media.decode() }
      media.style.cssText = `width:${width}px;height:${height}px;${style}`
      document.body.append(media)
      const effect = morph(options), handle = core.comice(media).use(effect)
      await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('Not ready')), 10000); handle.on('ready', () => { clearTimeout(timer); resolve() }); handle.on('error', (_, e) => { clearTimeout(timer); reject(e.error) }) })
      handle.set(effect, { progress })
      window.active = { media, effect, handle }
    }
    window.pixels = (progress = 1) => {
      const { media, effect, handle } = window.active; handle.set(effect, { progress })
      const canvas = media.nextElementSibling, gl = canvas.getContext('webgl2'), data = new Uint8Array(canvas.width * canvas.height * 4)
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, data)
      if (gl.getError()) throw Error('GL error')
      return { data, width: canvas.width, height: canvas.height }
    }
    window.cleanup = () => { window.active.handle.destroy(); window.active.media.remove() }
  })
  for (const [i, clipPath] of cases.entries()) {
    try {
      const supported = await page.evaluate(value => CSS.supports('clip-path', value), clipPath)
      if (!supported) throw Error('Native CSS rejects supported parser syntax')
      await page.evaluate(value => { const div = document.createElement('div'); div.id = 'reference'; div.style.cssText = 'position:absolute;left:0;top:0;width:400px;height:200px;background:white'; div.style.clipPath = value; document.body.append(div) }, clipPath)
      const reference = (await page.screenshot({ clip: { x: 0, y: 0, width: 400, height: 200 }, omitBackground: true })).toString('base64')
      const result = await page.evaluate(async ({ clipPath, reference }) => {
        document.getElementById('reference').remove()
        await window.mount({ to: { clipPath }, liquid: 0 })
        const gpu = window.pixels()
        const img = new Image(); img.src = 'data:image/png;base64,' + reference; await img.decode()
        const canvas = document.createElement('canvas'); canvas.width = 400; canvas.height = 200
        const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0)
        const native = ctx.getImageData(0, 0, 400, 200).data
        let total = 0, mismatch = 0
        for (let y = 0; y < 200; y++) for (let x = 0; x < 400; x++) {
          const a = native[(y * 400 + x) * 4 + 3], b = gpu.data[((199 - y) * 400 + x) * 4 + 3]
          total += Math.abs(a - b); if (Math.abs(a - b) > 128) mismatch++
        }
        window.cleanup(); return { mean: total / 80000, mismatch: mismatch / 80000 }
      }, { clipPath, reference })
      if (!Number.isFinite(result.mean) || result.mean > 3 || result.mismatch > .012) throw Error(JSON.stringify(result))
      console.log(name, 'native-css', i, 'PASS', JSON.stringify(result))
    } catch (e) { failed = true; console.error(name, 'native-css', i, clipPath, 'FAIL', e.message) }
  }
  const behavior = await page.evaluate(async () => {
    const results = []
    const check = async (name, run) => { try { await run(); results.push({ name, ok: true }) } catch (e) { results.push({ name, ok: false, error: e.message }); if (window.active?.media.isConnected) window.cleanup() } }
    await check('large curved morphs retain smooth alpha during motion and at the endpoint', async () => {
      await window.mount({ to: 'ellipse(42% 35%)', liquid: 0 }, 0, 1200, 675)
      for (const progress of [.2, .5, 1]) {
        const { data } = window.pixels(progress), levels = new Set()
        let partial = 0
        for (let i = 3; i < data.length; i += 4) if (data[i] > 0 && data[i] < 255) { levels.add(data[i]); partial++ }
        if (levels.size < 16 || !partial || partial > data.length / 4 * .05) throw Error(`Contour is hard or excessively blurred at ${progress}: ${levels.size}/${partial}`)
      }
      window.cleanup()
    })
    await check('a stationary pointer and still image stop issuing GPU draws', async () => {
      await window.mount({ to: 'ellipse(40% 35%)', cursorFollow: false, interaction: true, liquid: 0 }, .5)
      const { media } = window.active, canvas = media.nextElementSibling, gl = canvas.getContext('webgl2')
      const original = gl.drawArrays.bind(gl)
      let draws = 0
      gl.drawArrays = (...args) => { draws++; original(...args) }
      try {
        document.dispatchEvent(new PointerEvent('pointermove', { clientX: 100, clientY: 100, bubbles: true }))
        await new Promise(r => setTimeout(r, 50))
        document.dispatchEvent(new PointerEvent('pointermove', { clientX: 240, clientY: 100, bubbles: true }))
        await new Promise(r => setTimeout(r, 3500))
        const before = draws
        await new Promise(r => setTimeout(r, 250))
        if (draws !== before) throw Error(`Idle image kept drawing: ${draws - before} draws`)
      } finally { gl.drawArrays = original; window.cleanup() }
    })
    await check('curved edges shrink continuously without stray overlays', async () => {
      await window.mount({ to: 'ellipse(35% 30%)', cursorFollow: false, liquid: 0 }, 0)
      let previous = Infinity
      for (let step = 0; step <= 100; step++) {
        const { data } = window.pixels(step / 100)
        let area = 0
        for (let i = 3; i < data.length; i += 4) area += data[i] / 255
        if (area > previous + 1) throw Error(`Edge jumped outward at ${step}%: ${previous}/${area}`)
        previous = area
      }
      window.cleanup()
    })
    await check('fast scroll bend preserves endpoints and leaves all four corners clear', async () => {
      await window.mount({ from: 'circle(35%)', to: 'inset(0 round 24px)', bend: { x: .02, y: .04 }, liquid: 0, cursorFollow: false }, 1, 612, 344)
      const { handle, effect } = window.active
      const read = (progress, velocity) => { handle.set(effect, { velocity }); return window.pixels(progress) }
      for (const progress of [0, 1]) {
        const reference = read(progress, 0)
        for (const velocity of [-20, -1, 1, 20]) {
          const actual = read(progress, velocity)
          for (let i = 3; i < actual.data.length; i += 4) {
            if (actual.data[i] !== reference.data[i]) throw Error(`Scroll speed changed endpoint ${progress} at alpha index ${i}`)
          }
        }
      }
      const still = read(.5, 0), moving = read(.5, 1)
      let changed = 0
      for (let i = 3; i < moving.data.length; i += 4) if (moving.data[i] !== still.data[i]) changed++
      if (changed < 100) throw Error('Scroll bend was disabled rather than stabilized')
      for (const progress of [.05, .5, .95, .995]) for (const velocity of [-20, -1, 1, 20]) {
        const { data, width, height } = read(progress, velocity)
        for (const [cx, cy] of [[0,0],[width-4,0],[0,height-4],[width-4,height-4]]) {
          for (let y=cy;y<cy+4;y++) for (let x=cx;x<cx+4;x++) if (data[(y*width+x)*4+3] > 1) throw Error(`Corner extrusion at ${progress}/${velocity}/${x}/${y}`)
        }
      }
      window.cleanup()
    })
    await check('responsive percentages and absolute path pixels', async () => {
      await window.mount({ to: 'circle(40px at 50% 50%)' })
      const before = window.pixels(); const beforeArea = Array.from(before.data).filter((v, i) => i % 4 === 3 && v > 127).length
      window.active.media.style.width = '600px'; window.active.media.style.height = '300px'
      // Background bakes commit together; wait for the rendered dimensions,
      // rather than assuming a worker finishes within a fixed 100ms.
      let after, afterArea
      for (const started = performance.now(); performance.now() - started < 3000;) {
        await new Promise(r => setTimeout(r, 50))
        after = window.pixels(); afterArea = Array.from(after.data).filter((v, i) => i % 4 === 3 && v > 127).length
        if (after.width === 600 && after.height === 300 && afterArea > 0) break
      }
      if (after.width !== 600 || after.height !== 300 || Math.abs(beforeArea - afterArea) > 100) throw Error(`Pixel radius changed: ${beforeArea}/${afterArea}/${after.width}`)
      window.cleanup()
    })
    await check('omitted from captures computed clip and elliptical corners', async () => {
      await window.mount({ to: 'inset(0)' }, 0, 400, 200, 'clip-path:ellipse(30% 40% at center)')
      const { data, width } = window.pixels(0)
      if (data[3] !== 0 || data[(100 * width + 200) * 4 + 3] !== 255) throw Error('Existing CSS clip was not captured')
      window.cleanup()
      await window.mount({ to: 'inset(0)' }, 0, 400, 200, 'border-radius:0 70px 0 30px / 0 40px 0 20px')
      const p = window.pixels(0); if (p.data[(199 * p.width + 399) * 4 + 3] > 5 || p.data[(199 * p.width + 1) * 4 + 3] < 200) throw Error('Different corner radii lost')
      window.cleanup()
    })
    await check('SVG CSS mixed joins separation sheen refraction and holes', async () => {
      await window.mount({ to: '/demo/assets/images/panel.svg', join: { points: [[.205,.5],[.5,.5],[.795,.5]] }, outline: { style: 'sheen', width: 8 }, glass: { width: 24, refraction: 18 } })
      const samples = [.0, .1, .3, .5, .85, 1].map(p => window.pixels(p).data.reduce((n, v, i) => n + (i % 4 === 3 ? v : 0), 0))
      if (new Set(samples).size < 5) throw Error('Separation failed to animate')
      const neck = window.pixels(.9), x = Math.floor((.5 + (412 - 612) / 688 * .5) * neck.width)
      const center = neck.data[(Math.floor(.5 * neck.height) * neck.width + x) * 4 + 3]
      const top = neck.data[(Math.floor(.88 * neck.height) * neck.width + x) * 4 + 3]
      if (center < 240 || top > 20) throw Error(`Explicit separation centers used the wrong endpoint: ${center}/${top}`)
      window.cleanup()
      await window.mount({ from: '/demo/assets/images/panel.svg', to: `path(evenodd, 'M10 10H390V190H10Z M140 60H260V140H140Z')`, join: { style: 'slab' }, direction: 'reverse' }, 0)
      const a = window.pixels(0); if (a.data[(100 * a.width + 200) * 4 + 3] > 5) throw Error('Destination hole filled'); window.pixels(.5); window.pixels(1); window.cleanup()
    })
    await check('joins preserve supplied outer edges and shared holes', async () => {
      for (const style of ['metaball', 'slab']) for (const direction of ['forward', 'reverse']) {
        await window.mount({ from: '/demo/assets/images/panel.svg', to: '/demo/assets/images/shape.svg', join: { style }, direction, outline: { style: 'sheen', width: 8 }, glass: { width: 24, refraction: 18 } }, 0, 612, 344)
        const start = window.pixels(0), end = window.pixels(1)
        const outside = []
        // Ignore two pixels of endpoint antialiasing when checking empty space.
        for (let y = 2; y < start.height - 2; y++) for (let x = 2; x < start.width - 2; x++) {
          let occupied = false
          for (let dy = -2; dy <= 2 && !occupied; dy++) for (let dx = -2; dx <= 2; dx++) {
            const i = ((y + dy) * start.width + x + dx) * 4 + 3
            if (start.data[i] || end.data[i]) { occupied = true; break }
          }
          if (!occupied) outside.push((y * start.width + x) * 4 + 3)
        }
        if (!outside.length) throw Error('Missing transparent endpoint margin')
        for (const progress of [.025, .1, .15, .3, .5, .7, .85, .88, .925]) {
          const current = window.pixels(progress)
          if (outside.some(i => current.data[i] > 5)) throw Error(`${style}/${direction}/${progress}: join protrudes outside supplied shapes`)
        }
        window.cleanup()
        const hole = `path(evenodd, 'M10 10H390V190H10Z M140 60H260V140H140Z')`
        await window.mount({ from: hole, to: hole, join: { style, points: [[.2,.5],[.8,.5]] }, direction })
        for (const progress of [.1,.5,.88]) {
          const current = window.pixels(progress)
          if (current.data[(100 * current.width + 200) * 4 + 3] > 5) throw Error('Joining filled a hole shared by both inputs')
        }
        window.cleanup()
      }
    })
    await check('native pointer softening wake and directional glass preserve endpoints', async () => {
      await window.mount({ from: '/demo/assets/images/panel.svg', to: '/demo/assets/images/shape.svg', join: true, interaction: { radius: 160, softness: 30, wake: 6, decay: .8 }, glass: { rim: .1 } }, .1, 612, 344)
      const initial = window.pixels(.1), start = window.pixels(0), end = window.pixels(1)
      window.pixels(.1)
      const move = (x,y) => document.body.dispatchEvent(new PointerEvent('pointermove',{clientX:x,clientY:y,bubbles:true}))
      move(20,170); await new Promise(r=>setTimeout(r,150)); move(210,170); await new Promise(r=>setTimeout(r,150))
      const active = window.pixels(.1)
      let changed=0;for(let i=0;i<active.data.length;i++) changed+=Math.abs(active.data[i]-initial.data[i])
      if(changed<100)throw Error('Pointer interaction did not change the field')
      if(window.active.effect.params.getParam('progress')!==.1)throw Error('Pointer overwrote progress')
      const gl=window.active.media.nextElementSibling.getContext('webgl2'),program=gl.getParameter(gl.CURRENT_PROGRAM)
      const interaction=()=>gl.getUniform(program,gl.getUniformLocation(program,'u_interaction'))
      const wake=interaction()[3];if(!(wake>0))throw Error('Moving pointer did not generate a wake')
      await new Promise(r=>setTimeout(r,800));window.pixels(.1)
      if(interaction()[3]>=wake)throw Error('Wake did not fade after movement stopped')
      for(const [progress,expected] of [[0,start],[1,end]]) {
        const actual=window.pixels(progress)
        if(actual.data.some((v,i)=>v!==expected.data[i]))throw Error('Interaction changed supplied endpoint')
      }
      window.cleanup()
    })
    await check('custom-font text endpoints fit, reverse and resize without clipping', async () => {
      const face = new FontFace('MorphTextCheck', 'url(/demo/assets/fonts/Geist-700.ttf)', { weight: '700' })
      document.fonts.add(face)
      const options = {
        from: { type: 'text', text: 'Olawale Balo', font: '700 160px MorphTextCheck' },
        to: { type: 'text', text: 'Design Engineer', font: '700 160px MorphTextCheck' },
        cursorFollow: false, liquid: 0, maskRasterization: { fill: .9 },
      }
      try {
        await window.mount(options, 0, 400, 200)
        if (face.status !== 'loaded') throw Error('Text baked before the requested font loaded')
        const bounds = pixels => {
          let left = pixels.width, right = -1, top = pixels.height, bottom = -1, area = 0
          for (let y = 0; y < pixels.height; y++) for (let x = 0; x < pixels.width; x++) {
            if (pixels.data[(y * pixels.width + x) * 4 + 3] > 127) {
              left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); area++
            }
          }
          if (!area || left < pixels.width * .04 || right > pixels.width * .96 || top < 1 || bottom >= pixels.height - 1) throw Error('Text is blank or clipped: ' + JSON.stringify({ left, right, top, bottom, area }))
          if (right - left < pixels.width * .87) throw Error('Text did not refit to the stage')
          return area
        }
        const start = window.pixels(0), end = window.pixels(1)
        bounds(start); bounds(end)
        if (start.data.every((value, i) => value === end.data[i])) throw Error('Text endpoints did not change')
        bounds(window.pixels(.5))
        const replay = window.pixels(0)
        if (replay.data.some((value, i) => value !== start.data[i])) throw Error('Reversing changed the name endpoint')
        window.active.media.style.width = '300px'; window.active.media.style.height = '300px'
        await new Promise(resolve => setTimeout(resolve, 600))
        bounds(window.pixels(0)); bounds(window.pixels(1))
        window.cleanup()
      } finally { document.fonts.delete(face) }
    })
    await check('video morphs to text and reverses to its full frame', async () => {
      await window.mount({ to: { type: 'text', text: 'Design Engineer', font: '700 160px sans-serif' }, liquid: 0, maskRasterization: { fill: .9 } }, 0, 400, 200, '', 'video')
      const frame = window.pixels(0), text = window.pixels(1), middle = window.pixels(.5)
      const area = data => { let sum = 0; for (let i = 3; i < data.length; i += 4) if (data[i] > 127) sum++; return sum }
      if (area(frame.data) < 79000 || area(text.data) < 100 || area(text.data) > 30000 || !area(middle.data)) throw Error('Video-to-text silhouette or frame is missing')
      const back = window.pixels(0)
      if (area(back.data) !== area(frame.data)) throw Error('Video did not return to its full frame')
      if (window.active.media.tagName !== 'VIDEO') throw Error('Video source was replaced')
      window.cleanup()
    })
    await check('unsupported syntax and catalog rejected', async () => {
      const { morph } = await import('@comice/morph')
      for (const options of [{ to: 'shape(from 0 0, line to 100% 100%)' }, { to: 'polygon(0% 0%, bogus, 100% 100%)' }, { to: 'circle(2em)' }, { layout: 'fan' }, { to: 'circle(40%)', stagger: .3 }]) {
        let error = false; try { morph(options) } catch { error = true } if (!error) throw Error('Invalid input accepted')
      }
      if (document.querySelector('canvas')) throw Error('Teardown left a canvas')
    })
    return results
  })
  console.log(name, JSON.stringify(behavior)); if (behavior.some(r => !r.ok)) failed = true
  await browser.close()
}
process.exitCode = failed ? 1 : 0
