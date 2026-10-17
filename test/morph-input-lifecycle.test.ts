import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test'
import { comice } from 'comice'
import { getSharedScheduler } from 'comice/scheduler'
import { morph } from '../packages/morph/src/index.js'
import { compileMorphProgram, destroyMorphProgram } from '../packages/morph/src/shape-program.js'
import { createFakeGL2, createFakeGLContext, installFake2DContext, type FakeGLOptions } from './fake-webgl2.js'
import { installFakeIntersectionObserver } from './fake-intersection.js'

let raster: ReturnType<typeof installFake2DContext>, observer: ReturnType<typeof installFakeIntersectionObserver>, original: typeof HTMLCanvasElement.prototype.getContext
const handles: ReturnType<typeof comice>[] = []
const drain = async () => { for (let i=0;i<10;i++) await Promise.resolve() }
beforeEach(() => { raster = installFake2DContext(); observer = installFakeIntersectionObserver(); original = HTMLCanvasElement.prototype.getContext })
afterEach(() => { handles.splice(0).forEach(h=>h.destroy()); observer.uninstall(); getSharedScheduler().stop(); HTMLCanvasElement.prototype.getContext=original; raster.uninstall(); document.body.innerHTML='' })
function fake(options: FakeGLOptions = {}) {
  const gl=createFakeGL2(options)
  HTMLCanvasElement.prototype.getContext=function(type:string,...args:unknown[]){return type==='webgl2'?gl:original.call(this,type as never,...args as never[])} as typeof original
  return gl
}
function media(video=false) {
  const target=document.createElement(video?'video':'img')
  Object.defineProperties(target, video?{readyState:{value:2},videoWidth:{value:0},videoHeight:{value:0}}:{complete:{value:true},naturalWidth:{value:40},naturalHeight:{value:20}})
  Object.defineProperty(target,'getBoundingClientRect',{value:()=>({left:0,top:0,width:40,height:20,right:40,bottom:20})})
  document.body.append(target);return target
}
function use(target:Element,effect= morph({to:'inset(0)',join:true})) {const h=comice(target).use(effect);handles.push(h);return {h,effect}}
describe('public shape morph lifecycle',()=>{
  it('clones caller inputs for multiple media elements', async () => {
    fake(); const effect=morph({to:'circle(40%)'}), clone=effect.create!(); expect(clone).not.toBe(effect); use(media(),clone); await drain()
  })
  it('rejects unsupported targets and reuse, including after destruction',async()=>{
    const div=document.createElement('div');document.body.append(div)
    expect(()=>use(div)).toThrow(/img/)
    fake();const m=media(),{h,effect}=use(m);await drain()
    expect(()=>effect.setup!(m,h)).toThrow(/once/);h.destroy()
    expect(()=>effect.setup!(m,h)).toThrow(/once/)
    effect.params!.setParam('velocity',1);expect(effect.params!.getParam('velocity')).toBe(0)
  })
  it('reports asynchronous mount conflicts while preserving the first effect',async()=>{
    fake();const target=media(),first=use(target);await drain();const canvas=document.querySelector('canvas')
    const errors:string[]=[];const second=use(target);second.h.on('error',(_,e)=>errors.push(e.error.message));await drain()
    expect(errors[0]).toMatch(/already does/);expect(document.querySelector('canvas')).toBe(canvas);expect(target.style.visibility).toBe('hidden');first.h.destroy()
  })
  it('reports context loss, restores media and clears scheduled drawing',async()=>{
    fake();const target=media(),{h}=use(target,morph({to:'circle(40%)',interaction:{radius:100,decay:.8}}));const errors:string[]=[];h.on('error',(_,e)=>errors.push(e.error.message));await drain()
    document.querySelector('canvas')!.dispatchEvent(new Event('webglcontextlost'));await drain()
    expect(errors[0]).toMatch(/context was lost/);expect(target.style.visibility).toBe('');expect(document.querySelector('canvas')).toBeNull()
  })
  it('retains pending progress and independent pointer/velocity parameters',async()=>{
    const gl=fake();let draws=0;gl.drawArrays=()=>{draws++}
    const {h,effect}=use(media(),morph({to:'circle(40%)',from:'inset(0)',direction:'reverse',maskRasterization:{resolution:[40,20]}}))
    h.set(effect,{progress:.7,mouseX:.3,mouseY:-.2,velocity:.1});await drain()
    expect(effect.params!.getParam('progress')).toBe(.7);expect(draws).toBeGreaterThan(0)
    for(const [name,value] of [['mouseX',.3],['mouseY',-.2],['velocity',.1]] as const)expect(effect.params!.getParam(name)).toBe(value)
    expect(effect.params!.getParam('unknown')).toBe(0);effect.params!.setParam('unknown',3);effect.params!.setParam('progress',NaN)
    h.setDisplay({x:30,y:40});h.ready('morph');expect(effect.params!.getParam('progress')).toBe(.7)
    observer.setVisible(false);const before=draws;h.set(effect,{progress:.2});expect(draws).toBe(before)
  })
  it('uses native pointer interaction without changing morph progress and cleans it up', async () => {
    const gl = fake(), oldRAF = requestAnimationFrame
    let tick: FrameRequestCallback = () => {}, uniforms: number[] = [], draws = 0
    globalThis.requestAnimationFrame = callback => { tick = callback; return 1 }
    gl.uniform4fv = (_location, value) => { uniforms = Array.from(value) }
    gl.drawArrays = () => { draws++ }
    let h: ReturnType<typeof comice> | undefined
    try {
      const target = media(), effect = morph({ from: 'inset(0)', to: 'circle(40%)', interaction: true })
      h = use(target, effect).h; await drain(); h.set(effect, { progress: .4 })
      document.body.dispatchEvent(new PointerEvent('pointermove', { clientX: 30, clientY: 10, bubbles: true }))
      tick(0)
      expect(uniforms[0]).toBeCloseTo(.75); expect(uniforms[2]).toBeGreaterThan(0)
      document.body.dispatchEvent(new PointerEvent('pointermove', { clientX: 8, clientY: 10, bubbles: true }))
      tick(1000 / 60)
      expect(uniforms[3]).toBeGreaterThan(0)
      expect(effect.params!.getParam('progress')).toBe(.4)
      observer.setVisible(false); tick(1000 / 30)
      h.destroy(); const before = draws
      document.body.dispatchEvent(new PointerEvent('pointermove', { clientX: 10, clientY: 10, bubbles: true })); tick(50)
      expect(draws).toBe(before)
    } finally { h?.destroy(); getSharedScheduler().stop(); globalThis.requestAnimationFrame = oldRAF }
  })

  it('uploads explicit connection centers with live surface controls', async () => {
    fake(); const {h,effect}=use(media(),morph({from:'inset(0)',to:'circle(40%)',join:{points:[[.2,.5],[.8,.5]]},outline:{style:'sheen',width:8},glass:{}})); await drain();h.set(effect,{progress:.5});expect(effect.params!.getParam('progress')).toBe(.5)
  })
  it('captures current CSS geometry and resizes both endpoint fields',async()=>{
    fake();const old=ResizeObserver;let resize=()=>{}
    globalThis.ResizeObserver=class{constructor(callback:ResizeObserverCallback){resize=()=>callback([],this as unknown as ResizeObserver)}observe(){}disconnect(){}unobserve(){}} as unknown as typeof ResizeObserver
    try {const target=media();target.style.clipPath='circle(40%)';const {h,effect}=use(target);await drain();resize();h.set(effect,{progress:.5});expect(target.style.visibility).toBe('hidden')}finally{globalThis.ResizeObserver=old}
  })
  describe('an omitted from or to is the media\'s own frame (its border-radius or clip-path)', () => {
    /** The paths the rasterizer is asked to draw, in order: [to, from]. */
    function paths() {
      const drawn: string[] = []
      const Original = (globalThis as { Path2D: new (d?: string) => unknown }).Path2D
      ;(globalThis as { Path2D: unknown }).Path2D = class { constructor(d?: string) { drawn.push(String(d)) } }
      return { drawn, restore: () => { (globalThis as { Path2D: unknown }).Path2D = Original } }
    }
    const radiusOf = (path: string) => /A(\d+(?:\.\d+)?) /.exec(path)?.[1]

    it('with no `to`, the end is the media\'s own border-radius, whatever the user set', async () => {
      for (const radius of ['8px', '0px', '50%']) {
        fake(); const { drawn, restore } = paths()
        try {
          const target = media(); target.style.borderRadius = radius
          const { h, effect } = use(target, morph({ from: 'circle(40%)' })); await drain()
          expect(drawn.length).toBeGreaterThanOrEqual(2)
          const to = drawn[0]!
          if (radius === '0px') expect(to).not.toContain('A')
          else if (radius === '50%') expect(to).toContain('A') // a percentage radius, as the CSS has it
          else expect(radiusOf(to)).toBe('8')
          h.set(effect, { progress: .5 }); expect(effect.params!.getParam('progress')).toBe(.5); expect(target.style.visibility).toBe('hidden')
        } finally { restore(); document.body.innerHTML = ''; handles.splice(0).forEach((x) => x.destroy()) }
      }
    })

    it('with no `from`, the start is the media\'s own border-radius, and a CSS clip-path wins over it', async () => {
      fake(); const { drawn, restore } = paths()
      try {
        const target = media(); target.style.borderRadius = '7px'
        use(target, morph({ to: 'circle(40%)' })); await drain()
        expect(drawn.some((path) => radiusOf(path) === '7')).toBe(true)
      } finally { restore(); document.body.innerHTML = ''; handles.splice(0).forEach((x) => x.destroy()) }
      fake(); const clipped = paths()
      try {
        const target = media(); target.style.borderRadius = '7px'; target.style.clipPath = 'circle(30%)'
        use(target, morph({ to: 'inset(0)' })); await drain()
        expect(clipped.drawn.some((path) => radiusOf(path) === '7')).toBe(false)
      } finally { clipped.restore() }
    })

    it('with neither, both ends are the media\'s frame and nothing breaks', async () => {
      fake(); const target = media(); target.style.borderRadius = '8px'
      const { h, effect } = use(target, morph({})); const errors: string[] = []
      h.on('error', (_, event) => { if (event.type === 'error') errors.push(event.error.message) })
      await drain()
      h.set(effect, { progress: .5 })
      expect(errors).toEqual([])
      expect(target.style.visibility).toBe('hidden')
    })

    it('follows the media if its radius changes (a media query or a class)', async () => {
      fake(); const old = ResizeObserver; let resize = () => {}
      globalThis.ResizeObserver = class { constructor(callback: ResizeObserverCallback) { resize = () => callback([], this as unknown as ResizeObserver) } observe() {} disconnect() {} unobserve() {} } as unknown as typeof ResizeObserver
      const { drawn, restore } = paths()
      try {
        const target = media(); target.style.borderRadius = '4px'
        const { h, effect } = use(target, morph({ from: 'circle(40%)' })); await drain()
        expect(radiusOf(drawn[0]!)).toBe('4')
        drawn.length = 0
        target.style.borderRadius = '9px'
        resize(); h.set(effect, { progress: .5 }); await drain()
        expect(drawn.some((path) => radiusOf(path) === '9')).toBe(true)
        // An unchanged radius is not re-read into a new bake.
        drawn.length = 0
        resize(); await drain()
        expect(drawn.length).toBeLessThanOrEqual(0)
      } finally { restore(); globalThis.ResizeObserver = old }
    })
  })
  describe('what shows under the empty canvas before the first frame', () => {
    const visibility = (el: HTMLElement) => el.style.visibility

    it('the media shows only while it looks exactly like the effect, and is hidden anywhere else', async () => {
      fake()
      const target = media()
      const { h, effect } = use(target, morph({ to: 'circle(40%)' })) // from is the media's own frame
      expect(visibility(target)).toBe('') // progress 0: the effect IS the media's frame
      h.set(effect, { progress: .5 })
      expect(visibility(target)).toBe('hidden') // mid-morph: the media would be the wrong shape
      h.set(effect, { progress: 0 })
      expect(visibility(target)).toBe('')
      h.set(effect, { progress: .5 })
      await drain()
      expect(visibility(target)).toBe('hidden') // painted: the canvas has it
    })

    it('a reversed morph matches at the other end', async () => {
      fake()
      const target = media()
      const { h, effect } = use(target, morph({ from: 'circle(40%)', direction: 'reverse' })) // `to` omitted
      expect(visibility(target)).toBe('') // progress 0, reversed, is `to`: the media's own frame
      h.set(effect, { progress: 1 })
      expect(visibility(target)).toBe('hidden') // progress 1, reversed, is the shape of `from`
      h.set(effect, { progress: .4 })
      expect(visibility(target)).toBe('hidden')
      h.set(effect, { progress: 0 })
      expect(visibility(target)).toBe('')
    })

    it('with a shape of your own at both ends, the media never shows', async () => {
      fake()
      const target = media()
      const { h, effect } = use(target, morph({ from: 'circle(40%)', to: 'inset(0)' }))
      expect(visibility(target)).toBe('hidden')
      h.set(effect, { progress: 0 }); expect(visibility(target)).toBe('hidden')
      h.set(effect, { progress: 1 }); expect(visibility(target)).toBe('hidden')
      await drain()
      expect(visibility(target)).toBe('hidden')
    })

    it('with neither end given, the media always matches', async () => {
      fake()
      const target = media()
      const { h, effect } = use(target, morph({}))
      h.set(effect, { progress: .5 })
      expect(visibility(target)).toBe('')
    })

    it('a shape that fails to load gives the media back', async () => {
      fake()
      const target = media()
      const { h } = use(target, morph({ from: 'circle(40%)', to: '<html/>' }))
      const errors: string[] = []
      h.on('error', (_, event) => { if (event.type === 'error') errors.push(event.error.message) })
      expect(visibility(target)).toBe('hidden')
      await drain()
      expect(errors.length).toBe(1)
      expect(visibility(target)).toBe('')
    })

    it('destroying while a shape is still loading restores the media', async () => {
      fake()
      const target = media(); target.style.visibility = 'visible'
      const pending = document.createElement('img'); Object.defineProperty(pending, 'complete', { value: false })
      const { h } = use(target, morph({ from: pending }))
      expect(visibility(target)).toBe('hidden')
      h.destroy()
      expect(visibility(target)).toBe('visible')
    })

    it('an effect that never paints gives the media back after ten seconds on screen, and waits while off screen', async () => {
      fake()
      jest.useFakeTimers()
      try {
        let top = 0
        const target = document.createElement('img')
        Object.defineProperties(target, { complete: { value: true }, naturalWidth: { value: 40 }, naturalHeight: { value: 20 } })
        Object.defineProperty(target, 'getBoundingClientRect', { value: () => ({ left: 0, top, width: 40, height: 20, right: 40, bottom: top + 20 }) })
        document.body.append(target)
        const pending = document.createElement('img'); Object.defineProperty(pending, 'complete', { value: false })
        const { h, effect } = use(target, morph({ from: pending }))
        expect(visibility(target)).toBe('hidden')
        top = 5000 // far below the viewport
        jest.advanceTimersByTime(10_000)
        expect(visibility(target)).toBe('hidden') // nothing is drawn off screen by design: it waits
        top = 0
        jest.advanceTimersByTime(10_000)
        expect(visibility(target)).toBe('') // on screen and still nothing: the original, for good
        h.set(effect, { progress: .5 })
        expect(visibility(target)).toBe('') // and it stays
      } finally { jest.useRealTimers() }
    })

    it('never leaves a source rectangle under a near-end scroll bend during handoff', async () => {
      fake()
      const proto = HTMLCanvasElement.prototype as { animate?: unknown }, imgProto = HTMLImageElement.prototype as { animate?: unknown }
      let cancelled = 0
      const animate = () => ({ onfinish: null, cancel: () => { cancelled++ } })
      proto.animate = animate; imgProto.animate = animate
      try {
        const target = media()
        const { h, effect } = use(target, morph({ from: 'circle(40%)', bend: true }))
        h.set(effect, { progress: 1 }); await drain()
        expect(visibility(target)).toBe('')
        // The old 2% endpoint tolerance kept the rectangle visible here.
        h.set(effect, { progress: .995, velocity: 1 }); await drain()
        expect(visibility(target)).toBe('hidden')
        expect(cancelled).toBeGreaterThan(0)
      } finally { delete proto.animate; delete imgProto.animate }
    })

    it('a handoff that is still fading finishes at once if the scroll leaves the media\'s frame', async () => {
      fake()
      const animation = () => ({ onfinish: null as null | (() => void), cancel: () => { cancelled++ } })
      let cancelled = 0
      const proto = HTMLCanvasElement.prototype as { animate?: unknown }, imgProto = HTMLImageElement.prototype as { animate?: unknown }
      proto.animate = animation; imgProto.animate = animation
      try {
        const target = media()
        const { h, effect } = use(target, morph({ from: 'circle(40%)' }))
        h.set(effect, { progress: 1 }) // the end that IS the media's frame
        await drain()
        expect(visibility(target)).toBe('') // fading in over the still-visible media
        h.set(effect, { progress: .5 }) // a fast scroll moves away mid-fade
        await drain()
        expect(cancelled).toBeGreaterThan(0)
        expect(visibility(target)).toBe('hidden') // no half-visible box under the shape
      } finally { delete proto.animate; delete imgProto.animate }
    })
  })

  it('handles video frames with unavailable dimensions',async()=>{fake();const {h,effect}=use(media(true));await drain();h.set(effect,{progress:.5});expect(effect.params!.getParam('progress')).toBe(.5)})
  it('degrades on unavailable GL and compile/link failures',async()=>{
    HTMLCanvasElement.prototype.getContext=function(type:string,...args:unknown[]){return type==='webgl2'?null:original.call(this,type as never,...args as never[])} as typeof original
    const noGL=media(),a=use(noGL);await drain();expect(noGL.style.visibility).toBe('');a.h.destroy()
    for(const options of [{failShaderCompile:true},{failProgramLink:true}]){fake(options);const target=media(),{h}=use(target);await drain();expect(target.style.visibility).toBe('');h.destroy()}
  })
  it('restores media and releases textures when background mask allocation fails', async () => {
    const gl = fake({ failCreateFramebuffer: true })
    const allocated = new Set<WebGLTexture>(), deleted = new Set<WebGLTexture>()
    const createTexture = gl.createTexture.bind(gl)
    gl.createTexture = () => { const texture = createTexture(); if (texture) allocated.add(texture); return texture }
    gl.deleteTexture = texture => { if (texture) deleted.add(texture) }
    let draws = 0
    gl.drawArrays = () => { draws++ }
    const target = media()
    const { h, effect } = use(target, morph({ from: { type: 'text', text: 'Olawale Balo' }, to: { type: 'text', text: 'Design Engineer' } }))
    const errors: string[] = []
    h.on('error', (_, event) => errors.push(event.error.message))
    await drain(); await drain()
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/Could not prepare the distance fields/)
    expect(target.style.visibility).toBe('')
    expect(document.querySelector('canvas')).toBeNull()
    expect(allocated.size).toBeGreaterThan(0)
    expect(deleted).toEqual(allocated)
    h.set(effect, { progress: .5 })
    expect(draws).toBe(0)
  })
  it('restores media when the completed background distance field cannot upload', async () => {
    const gl = fake(), upload = gl.texImage2D
    gl.texImage2D = ((...args: unknown[]) => {
      if (args[2] === gl.R16F) throw new Error('Mask upload failed')
      return upload.apply(gl, args as never)
    }) as typeof upload
    const target = media(), { h, effect } = use(target)
    const errors: string[] = []
    h.on('error', (_, event) => errors.push(event.error.message))
    await drain(); await drain()
    expect(errors).toEqual(['Mask upload failed'])
    expect(target.style.visibility).toBe('')
    expect(document.querySelector('canvas')).toBeNull()
    h.set(effect, { progress: .5 })
    expect(effect.params!.getParam('progress')).toBe(0)
  })
  it('restores media after a texture upload fails following shape initialization', async () => {
    const gl=fake(),upload=gl.texImage2D;gl.texImage2D=((...args:unknown[])=>{if(args.length===6)throw Error('Media CORS upload failed');return upload.apply(gl,args as never)}) as typeof upload
    const target=media(),{h,effect}=use(target);const errors:string[]=[];h.on('error',(_,e)=>errors.push(e.error.message));await drain();h.set(effect,{progress:.5});expect(target.style.visibility).toBe('');expect(errors[0]).toMatch(/CORS/)
  })
  it('keeps both endpoint paths valid under live reduced-motion changes',async()=>{
    fake();let reduced=false,tick:FrameRequestCallback=()=>{}
    const oldRAF=requestAnimationFrame,oldMatch=matchMedia
    globalThis.matchMedia=(()=>({get matches(){return reduced}})) as typeof matchMedia
    globalThis.requestAnimationFrame=(callback)=>{tick=callback;return 1}
    try{const {h,effect}=use(media());await drain();h.set(effect,{progress:.4});reduced=true;tick(16);expect(effect.params!.getParam('progress')).toBe(0);reduced=false;tick(32);expect(effect.params!.getParam('progress')).toBe(.4)}finally{globalThis.requestAnimationFrame=oldRAF;globalThis.matchMedia=oldMatch}
  })
})
describe('shape GPU allocation failures',()=>{
  it('cleans surviving shaders, failed links, programs and geometry',()=>{
    for(const options of [{failShaderCompile:true},{failProgramLink:true},{failCreateProgram:true}]){const gl=createFakeGL2(options);expect(compileMorphProgram(gl,{hasFromMask:true})).toBeNull()}
    for(const allocation of ['createVertexArray','createBuffer'] as const){const gl=createFakeGL2();gl[allocation]=()=>null;expect(compileMorphProgram(gl,{})).toBeNull()}
    const gl=createFakeGL2();let checks=0;gl.getShaderParameter=()=>++checks===1;expect(compileMorphProgram(gl,{})).toBeNull()
    const ctx=createFakeGLContext(document.createElement('canvas'));const p=compileMorphProgram(ctx.gl,{hasFromMask:true,join:{},shapeTransition:true})!;destroyMorphProgram(ctx.gl,p)
  })
})

describe('background shader compile (KHR_parallel_shader_compile)', () => {
  const COMPLETION = 0x91b1
  function parallel() {
    const gl = fake()
    let done = false, deleted = 0
    const getProgramParameter = gl.getProgramParameter.bind(gl)
    gl.getExtension = ((name: string) => name === 'KHR_parallel_shader_compile' ? { COMPLETION_STATUS_KHR: COMPLETION } : null) as typeof gl.getExtension
    gl.getProgramParameter = ((program: WebGLProgram, name: number) => name === COMPLETION ? done : getProgramParameter(program, name)) as typeof gl.getProgramParameter
    const deleteProgram = gl.deleteProgram.bind(gl)
    gl.deleteProgram = ((program: WebGLProgram) => { deleted++; deleteProgram(program) }) as typeof gl.deleteProgram
    return { gl, finish: () => { done = true }, deleted: () => deleted }
  }

  it('keeps the media on screen while the driver compiles, then takes over', async () => {
    const { gl, finish } = parallel()
    let draws = 0
    gl.drawArrays = () => { draws++ }
    const target = media(), { h, effect } = use(target, morph({ to: 'circle(40%)' }))
    await drain()
    h.set(effect, { progress: 0 })
    expect(draws).toBe(0)
    expect(target.style.visibility).toBe('') // at the media's own frame, so it stays until the first draw
    finish()
    h.set(effect, { progress: .6 })
    await drain()
    expect(draws).toBeGreaterThan(0)
    expect(target.style.visibility).toBe('hidden')
  })

  it('a teardown while it compiles releases the program', async () => {
    const { deleted } = parallel()
    const target = media(), { h } = use(target, morph({ to: 'circle(40%)' }))
    await drain()
    h.destroy()
    expect(deleted()).toBe(1)
    expect(target.style.visibility).toBe('')
  })
})

it('a context that cannot create a program shows the original media and says why', async () => {
  fake({ failCreateProgram: true })
  const target = media(), { h } = use(target, morph({ to: 'circle(40%)' }))
  const errors: string[] = []
  h.on('error', (_, event) => { if (event.type === 'error') errors.push(event.error.message) })
  await drain()
  expect(errors.length + (document.querySelector('canvas') ? 0 : 1)).toBeGreaterThan(0)
  expect(target.style.visibility).toBe('')
  expect(document.querySelector('canvas')).toBeNull()
})
