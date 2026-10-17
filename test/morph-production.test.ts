import { afterEach, describe, expect, it } from 'bun:test'
import { comice } from 'comice'
import { hasGLContext } from 'comice/gl'
import { getSharedScheduler } from 'comice/scheduler'
import { legacyMorph as morph } from '../harness/morph/legacy-engine/index.js'
import { compileMorphProgram, destroyMorphProgram } from '../harness/morph/legacy-engine/shader.js'
import { createFakeGL2, createFakeGLContext } from './fake-webgl2.js'
import { installFakeIntersectionObserver } from './fake-intersection.js'

const original = HTMLCanvasElement.prototype.getContext
let handles: ReturnType<typeof comice>[] = []
afterEach(() => { handles.splice(0).forEach((h) => h.destroy()); HTMLCanvasElement.prototype.getContext = original; document.body.innerHTML = '' })
function image() {
  const img = document.createElement('img'); Object.defineProperties(img, { complete: { value: true }, naturalWidth: { value: 800 }, naturalHeight: { value: 600 } }); document.body.append(img); return img
}
function fakeGL() {
  const gl = createFakeGL2()
  HTMLCanvasElement.prototype.getContext = function (type: string, ...args: unknown[]) { return type === 'webgl2' ? gl : original.call(this, type as any, ...args as any) } as typeof original
  return gl
}
describe('morph production regressions', () => {
  it.each([NaN, Infinity, -Infinity])('rejects non-finite shader options (%s)', (value) => {
    expect(() => morph({ operation: 'merge', liquid: value })).toThrow(/finite/)
    expect(() => morph({ operation: 'merge', thread: { sag: value } })).toThrow(/finite/)
  })
  it('rejects degenerate transition and stagger windows', () => {
    expect(() => morph({ operation: 'recompose', recomposeStart: .5, recomposeEnd: .5 })).toThrow(/recomposeStart/)
    expect(() => morph({ operation: 'merge', stagger: 1 })).toThrow(/stagger/)
    expect(() => morph({ operation: 'merge', stagger: -.1 })).toThrow(/stagger/)
  })
  it('requires a mask for recomposition into a caller-supplied shape', () => {
    expect(() => morph({ operation: 'recompose', recomposeTarget: 'mask' })).toThrow(/needs a shape/)
    expect(() => morph({ operation: 'recompose', recomposeTarget: 'mask', into: 'text', text: 'ACME' })).not.toThrow()
  })
  it('accepts the spec default thread: false without creating a bridge', () => {
    expect(() => morph({ operation: 'merge', thread: false })).not.toThrow()
    expect(() => morph({ operation: 'mask', maskStyle: 'liquid', into: 'text', text: 'ACME', thread: false })).not.toThrow()
    const context = createFakeGLContext(document.createElement('canvas'))
    const program = compileMorphProgram(context.gl, { operation: 'merge', layout: 'shelf', thread: false })
    expect(program).not.toBeNull()
    if (program) destroyMorphProgram(context.gl, program)
  })
  it('compiles the contour, liquid and caller-supplied recomposition mask shaders', () => {
    const context = createFakeGLContext(document.createElement('canvas'))
    for (const options of [
      { operation: 'mask', maskStyle: 'contour', direction: 'reverse' },
      { operation: 'mask', maskStyle: 'liquid' },
      { operation: 'recompose', layout: 'waveTiles', recomposeTarget: 'mask', stagger: 0 },
      { operation: 'distribute', layout: 'deck', stagger: 0 },
      { operation: 'mask', maskStyle: 'liquid', glass: {}, outline: {} },
      { operation: 'mask', maskStyle: 'contour', glass: {}, outline: {} },
      { operation: 'merge', layout: 'shelf', glass: { width: 0 }, outline: { width: 0 } },
      { operation: 'mask', shapeTransition: true, hasFromMask: true, join: { style: 'slab', width: 5 }, glass: false },
      { operation: 'mask', shapeTransition: true, hasFromMask: true, join: { width: 4 }, liquidSheen: 0 },
      { operation: 'mask', shapeTransition: true, outline: { style: 'sheen' } },
      { operation: 'merge', layout: 'shelf', outline: { style: 'sheen', width: 12, opacity: .3 } },
    ] as const) {
      const program = compileMorphProgram(context.gl, options)
      expect(program).not.toBeNull()
      if (program) destroyMorphProgram(context.gl, program)
    }
  })
  it('releases its context and canvas on teardown so a long page can mount new instances', () => {
    fakeGL(); const img = image(), h = comice(img).use(morph({ operation: 'merge' })); handles.push(h)
    expect(hasGLContext(img)).toBe(true); h.destroy()
    expect(hasGLContext(img)).toBe(false); expect(document.querySelector('canvas')).toBeNull(); expect(img.style.visibility).toBe('')
  })
  it('a rejected second GPU plugin leaves the original effect running', () => {
    fakeGL(); const img = image(), a = comice(img).use(morph({ operation: 'merge' })), b = comice(img); handles.push(a, b)
    const canvas = document.querySelector('canvas')
    expect(() => b.use(morph({ operation: 'breakout' }))).toThrow(/already does/)
    expect(document.querySelector('canvas')).toBe(canvas); expect(hasGLContext(img)).toBe(true); expect(img.style.visibility).toBe('hidden')
  })
  it('reports context loss and restores the original media', async () => {
    fakeGL(); const img = image(), h = comice(img).use(morph({ operation: 'merge' })); handles.push(h)
    const errors: string[] = []; h.on('error', (_, e) => { if (e.type === 'error') errors.push(e.error.message) })
    document.querySelector('canvas')!.dispatchEvent(new Event('webglcontextlost'))
    await Promise.resolve(); expect(img.style.visibility).toBe(''); expect(document.querySelector('canvas')).toBeNull(); expect(errors[0]).toMatch(/context was lost/)
  })
  it('clears each drawn frame so reversing a morph cannot accumulate old silhouettes', () => {
    const gl = fakeGL(); let cleared = 0; let drawn = 0
    gl.clear = () => { cleared++ }; gl.drawArrays = () => { drawn++ }
    const observer = installFakeIntersectionObserver()
    try {
      const img = image(), p = morph({ operation: 'breakout' }), h = comice(img).use(p); handles.push(h)
      h.set(p, { progress: .7 }); h.set(p, { progress: .2 })
      expect(drawn).toBeGreaterThanOrEqual(3); expect(cleared).toBe(drawn)
      observer.setVisible(false); const previous = drawn; h.set(p, { progress: .5 }); expect(drawn).toBe(previous)
    } finally { observer.uninstall() }
  })
  it('follows live reduced-motion changes without losing the requested progress', () => {
    fakeGL()
    const oldRAF = requestAnimationFrame, oldMatch = matchMedia
    let reduced = false, tick: FrameRequestCallback = () => {}
    globalThis.matchMedia = (() => ({ get matches() { return reduced } })) as typeof matchMedia
    globalThis.requestAnimationFrame = (cb) => { tick = cb; return 1 }
    const observer = installFakeIntersectionObserver()
    try {
      const img = image(), p = morph({ operation: 'merge' }), h = comice(img).use(p); handles.push(h)
      h.set(p, { progress: .4 }); expect(p.params!.getParam('progress')).toBe(.4)
      reduced = true; tick(16); expect(p.params!.getParam('progress')).toBe(0)
      reduced = false; tick(32); expect(p.params!.getParam('progress')).toBe(.4)
    } finally { observer.uninstall(); getSharedScheduler().stop(); globalThis.requestAnimationFrame = oldRAF; globalThis.matchMedia = oldMatch }
  })
  it('parameter overrides survive ready and display events', () => {
    fakeGL(); const img = image(), p = morph({ operation: 'merge' }), h = comice(img).use(p); handles.push(h)
    h.set(p, { progress: .7 }); h.setDisplay({ x: 30, y: 40 }); h.ready('morph')
    expect(p.params!.getParam('progress')).toBe(.7)
    h.set(p, { velocity: NaN, progress: Infinity }); expect(p.params!.getParam('progress')).toBe(.7); expect(p.params!.getParam('velocity')).toBe(0)
  })
  it('releases the geometry buffer with its shader program', () => {
    const context = createFakeGLContext(document.createElement('canvas')); let buffer: WebGLBuffer | null = null
    context.gl.deleteBuffer = (value) => { buffer = value }
    const p = compileMorphProgram(context.gl, { operation: 'merge', layout: 'shelf' })!
    destroyMorphProgram(context.gl, p); expect(buffer).toBe(p.buffer)
  })
  it('cleans a surviving shader when the other fails to compile', () => {
    const context = createFakeGLContext(document.createElement('canvas')); let checks = 0, deleted = 0
    context.gl.getShaderParameter = () => ++checks === 1; context.gl.deleteShader = () => { deleted++ }
    expect(compileMorphProgram(context.gl, { operation: 'merge', layout: 'shelf' })).toBeNull(); expect(deleted).toBe(2)
  })
  it('cleans both shaders when program allocation fails', () => {
    const context = createFakeGLContext(document.createElement('canvas'), { failCreateProgram: true }); let deleted = 0
    context.gl.deleteShader = () => { deleted++ }
    expect(compileMorphProgram(context.gl, { operation: 'merge', layout: 'shelf' })).toBeNull(); expect(deleted).toBe(2)
  })
  it('cleans failed geometry allocations', () => {
    const context = createFakeGLContext(document.createElement('canvas')); let deleted = 0
    context.gl.createBuffer = () => null; context.gl.deleteProgram = () => { deleted++ }
    expect(compileMorphProgram(context.gl, { operation: 'merge', layout: 'shelf' })).toBeNull(); expect(deleted).toBe(1)
  })
})
