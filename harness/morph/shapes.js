import { comice } from 'comice'
import { morph } from '@comice/morph'
import { metaballReferenceChecks } from './metaball.js'

// Exercise the public SVG API through real browser decoding and GPU readback.
export async function shapeChecks() {
  const results = []
  const panels = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200"><rect x="10" y="10" width="100" height="180" rx="12"/><rect x="150" y="10" width="100" height="180" rx="12"/><rect x="290" y="10" width="100" height="180" rx="12"/></svg>'
  const frame = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200"><rect x="10" y="10" width="380" height="180" rx="12"/></svg>'
  const ring = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200"><defs><path id="ring" fill-rule="evenodd" d="M80 0A80 80 0 1 0-80 0A80 80 0 1 0 80 0Z M28 0A28 28 0 1 1-28 0A28 28 0 1 1 28 0Z"/></defs><use href="#ring" transform="translate(200 100)"/></svg>'
  async function mount(options, progress = 0) {
    const media = new Image(); media.src = '/harness/morph/fixtures/midtone.png'; await media.decode()
    media.style.cssText = 'position:fixed;left:0;top:0;width:400px;height:200px;border-radius:12px'
    document.body.append(media)
    const effect = morph(options), handle = comice(media).use(effect)
    handle.set(effect, { progress })
    const cleanup = () => { handle.destroy(); media.remove() }
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Shape never became ready.')), 12000)
        handle.on('ready', () => { clearTimeout(timer); resolve() })
        handle.on('error', (_, event) => { clearTimeout(timer); reject(event.error) })
      })
      const canvas = media.nextElementSibling, gl = canvas.getContext('webgl2')
      const sample = (progress, positions) => {
        handle.set(effect, { progress })
        return positions.map(([x, y]) => {
          const rgba = new Uint8Array(4)
          gl.readPixels(Math.floor(x * canvas.width), Math.floor((1 - y) * canvas.height), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, rgba)
          return Array.from(rgba)
        })
      }
      return { media, handle, effect, canvas, gl, sample, cleanup }
    } catch (error) {
      const hidden = media.style.visibility === 'hidden'
      cleanup()
      if (hidden) throw new Error('A failed shape load left the original media hidden.')
      throw error
    }
  }
  async function check(id, run) {
    try { const data = await run(); results.push({ id, ok: true, ...data }) }
    catch (error) { results.push({ id, ok: false, error: error.message }) }
  }
  await check('svg-metaball-supplied-reference', metaballReferenceChecks)
  await check('svg-metaball-neck-growth', async () => {
    const m = await mount({ from: '/demo/morph/assets/panel.svg', to: '/demo/morph/assets/shape.svg', join: true })
    try {
      // The 1224×688 SVG is contained in the 400×200 test media.
      const x = .5 + (412 - 612) / 688 * 200 / 400
      const points = [[x,.5],[x,.4],[x,.12]]
      const start = m.sample(0,points).map(p=>p[3])
      const early = m.sample(.1,points).map(p=>p[3])
      const growing = m.sample(.3,points).map(p=>p[3])
      const end = m.sample(1,points).map(p=>p[3])
      if(start.some(v=>v>5)||early[0]<250||early[1]>5||early[2]>5||growing[1]<250||end.some(v=>v<250)) throw new Error(`Midpoint drops must grow into a widening neck: ${JSON.stringify({start,early,growing,end})}`)
      if(m.gl.getError()!==0) throw new Error('GPU error while growing midpoint drops.')
      return {start,early,growing,end}
    } finally {m.cleanup()}
  })
  await check('svg-metaball-reverse-endpoints-and-holes', async () => {
    const m = await mount({from:panels,to:ring,join:true,direction:'reverse',outline:{width:2},glass:{width:20},liquidSheen:0},1)
    try {
      const start = m.sample(1,[[.325,.12],[.25,.5]]).map(p=>p[3])
      m.sample(.5,[[.5,.5]])
      const end = m.sample(0,[[.5,.5],[.65,.5],[.05,.05]]).map(p=>p[3])
      if(start[0]!==0||start[1]!==255||end[0]!==0||end[1]!==255||end[2]!==0||m.gl.getError()!==0) throw new Error(`Reverse midpoint drops changed the supplied endpoints: ${JSON.stringify({start,end})}`)
      return {start,end}
    } finally {m.cleanup()}
  })
  await check('svg-center-connection', async () => {
    const m = await mount({ from: panels, to: frame, join: { style: 'slab' }, liquid: 0 })
    try {
      const points = [[.325, .5], [.325, .12]]
      const start = m.sample(0, points).map((p) => p[3])
      const joining = m.sample(.025, points).map((p) => p[3])
      const end = m.sample(1, points).map((p) => p[3])
      if (start.some((v) => v !== 0) || joining[0] < 250 || joining[1] > 5 || end.some((v) => v < 250)) throw new Error(`Join must form at the middle first: ${JSON.stringify({start, joining, end})}`)
      if (m.gl.getError() !== 0) throw new Error('GPU error during SVG connection.')
      return { start, joining, end }
    } finally { m.cleanup() }
  })
  await check('svg-responsive-auto-connection', async () => {
    const staggered = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200"><rect x="30" y="20" width="100" height="40"/><rect x="270" y="140" width="100" height="40"/></svg>'
    const m = await mount({ from: staggered, to: frame, join: { style: 'slab' }, liquid: 0 })
    try {
      m.media.style.width = '300px'; m.media.style.height = '300px'
      // Separation-aware threads grow out of negative width, so their first
      // pixels may be antialiased. Verify growth into a solid neck after resize.
      // The re-bake for the new size runs in the background (it no longer
      // stalls a resize), so give it a moment to land before judging.
      const read = () => ({ joining: m.sample(.025, [[.4, .45], [.4, .35]]).map((p) => p[3]), grown: m.sample(.075, [[.4, .45], [.4, .35]]).map((p) => p[3]) })
      const connected = ({ joining, grown }) => !(joining[0] <= 5 || joining[1] > 5 || grown[0] < 250 || grown[0] < joining[0] || grown[1] > 5)
      let state = read()
      for (const started = performance.now(); !connected(state) && performance.now() - started < 3000;) {
        await new Promise((resolve) => setTimeout(resolve, 50))
        state = read()
      }
      const { joining, grown } = state
      if (!connected(state) || m.gl.getError() !== 0) throw new Error(`Resizing detached the SVG's automatic connection: ${joining}/${grown}`)
      return { joining, grown }
    } finally { m.cleanup() }
  })
  await check('svg-growth-preserves-deep-distances', async () => {
    const m = await mount({ from: panels, to: frame, join: false, liquid: 0 })
    try {
      m.media.style.width = '800px'; m.media.style.height = '400px'
      // Resize bakes are asynchronous. Sample only after the new fields have
      // committed and the backing store has rendered at its new dimensions.
      for (const started = performance.now(); performance.now() - started < 3000;) {
        m.sample(.5, [[.5, .5]])
        if (m.canvas.width === 800 && m.canvas.height === 400) break
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      if (m.canvas.width !== 800 || m.canvas.height !== 400) throw Error('Resized fields never committed.')
      // A point deep in the gap between panels fills in one sharp step. A
      // saturated or low-precision field would fill it early, late or in a
      // smear. (Core rounds the field's far creases, so the step lands a
      // little before the plain linear blend's 25%.)
      const steps = [.12, .14, .16, .18, .2, .22, .24, .26, .28, .3].map((p) => [p, m.sample(p, [[.325, .35]])[0][3]])
      const first = steps.findIndex(([, a]) => a > 0)
      const crossing = steps[first]?.[0]
      const sharp = first > 0 && steps.slice(0, first).every(([, a]) => a === 0) && steps.slice(first).every(([, a]) => a === 255)
      if (!sharp || crossing < .16 || crossing > .28 || m.gl.getError() !== 0) throw new Error(`Deep SVG distances saturated or lost precision: ${steps.map(([p, a]) => p + ':' + a).join(' ')}`)
      return { crossing }
    } finally { m.cleanup() }
  })
  for (const kind of ['document', 'element']) await check(`svg-${kind}-holes-and-transforms`, async () => {
    const to = kind === 'document' ? ring : new DOMParser().parseFromString(ring, 'image/svg+xml').documentElement
    const m = await mount({ to }, .73)
    try {
      if (m.effect.params.getParam('progress') !== .73) throw new Error('Loading reset the pending mapped progress.')
      const start = m.sample(0, [[.5, .5]])[0][3]
      const end = m.sample(1, [[.5, .5], [.65, .5], [.05, .05]]).map((p) => p[3])
      if (start !== 255 || end[0] !== 0 || end[1] !== 255 || end[2] !== 0) throw new Error(`SVG defs, hole or transform was lost: ${end}`)
      return { start, end }
    } finally { m.cleanup() }
  })
  await check('svg-url-and-image-input', async () => {
    const source = new Image(); source.src = '/demo/assets/images/apple.svg'; await source.decode()
    for (const to of ['/demo/assets/images/apple.svg', source]) {
      const m = await mount({ to, glass: { width: 20, refraction: 12 }, outline: { width: 2, color: '#ffffff' } })
      try {
        const alpha = m.sample(1, [[.5, .5], [.01, .01]]).map((p) => p[3])
        if (alpha[0] !== 255 || alpha[1] !== 0 || m.gl.getError() !== 0) throw new Error('SVG input or surface shader failed.')
      } finally { m.cleanup() }
    }
    return {}
  })
  await check('outline-and-refraction-are-independent', async () => {
    const positions = [[.5, .056], [.5, .095], [.5, .5]]
    const read = async (options) => {
      const m = await mount({ to: frame, ...options })
      try { const bytes = m.sample(1, positions); if (m.gl.getError() !== 0) throw new Error('Surface GPU error.'); return bytes }
      finally { m.cleanup() }
    }
    const plain = await read({ outline: false, glass: false })
    const outlined = await read({ outline: { width: 3 }, glass: false })
    const glass = await read({ outline: false, glass: { width: 24, refraction: 18, sheen: .15 } })
    if (!outlined[0].slice(0, 3).every((v) => v >= 240)) throw new Error('Outline did not follow the SVG boundary.')
    if (JSON.stringify(plain[2]) !== JSON.stringify(outlined[2]) || JSON.stringify(plain[2]) !== JSON.stringify(glass[2])) throw new Error('Surface options changed the flat interior.')
    if (JSON.stringify(plain[1]) === JSON.stringify(glass[1])) throw new Error('Glass refraction did not bend edge sampling.')
    return { plain, outlined, glass }
  })
  await check('soft-outline-preserves-media-and-fades-inward', async () => {
    const positions = [[.5,.0575],[.5,.0725],[.5,.0975],[.5,.15]]
    const read = async (outline) => {
      const m = await mount({to:frame,outline,glass:false})
      try {
        const pixels = m.sample(1,positions)
        if(m.gl.getError()!==0) throw new Error('GPU error drawing a soft outline.')
        return pixels
      } finally {m.cleanup()}
    }
    const plain = await read(false), soft = await read({style:'sheen',width:12,opacity:.3})
    const light = soft.map((pixel,i)=>pixel[2]-plain[i][2])
    if(!(light[0]>light[1]&&light[1]>light[2]&&light[2]>0&&light[3]===0)) throw new Error(`Soft outline must taper gradually into the media: ${light}`)
    if(soft.some((pixel,i)=>pixel[3]!==plain[i][3])||soft[0].slice(0,3).every(value=>value>240)) throw new Error('Soft outline changed the silhouette or replaced media with white.')
    return {light}
  })
  await check('surface-options-on-supplied-shapes', async () => {
    for (const options of [
      { from: '/demo/morph/assets/panel.svg', to: 'inset(0)', join: true },
      { to: { type: 'text', text: 'COMICE' } },
      { to: { type: 'shape', path: 'M0 0L100 0L50 100Z', viewBox: [0, 0, 100, 100] } },
    ]) {
      const m = await mount({ ...options, outline: { width: 2 }, glass: { width: 20, refraction: 10 } })
      try { m.sample(.5, [[.5, .5]]); if (m.gl.getError() !== 0) throw new Error('Legacy surface shader reported a GPU error.') }
      finally { m.cleanup() }
    }
    return {}
  })
  await check('bad-shape-preserves-media-and-cleans-up', async () => {
    let failed = false
    try { await mount({ to: '<html/>' }) } catch (error) { if (!error.message.includes('Invalid SVG')) throw error; failed = true }
    if (!failed) throw new Error('Malformed SVG was accepted.')
    failed = false
    try { await mount({ to: '/demo/assets/images/missing-shape.svg' }) } catch (error) { if (!error.message.includes('Could not load morph shape')) throw error; failed = true }
    if (!failed) throw new Error('Missing shape URL was accepted.')
    const media = new Image(); media.src = '/harness/morph/fixtures/midtone.png'; await media.decode(); document.body.append(media)
    const pending = new Image(), handle = comice(media).use(morph({ to: pending }))
    handle.destroy(); await new Promise((resolve) => setTimeout(resolve, 20))
    const ok = media.style.visibility !== 'hidden' && !(media.nextElementSibling instanceof HTMLCanvasElement)
    media.remove(); if (!ok) throw new Error('A canceled shape load mounted a GPU surface or hid media.')
    return {}
  })
  return results
}
