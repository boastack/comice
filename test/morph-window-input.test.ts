/**
 * test/morph-window-input — the page's pointer and scroll speed for cursorFollow and bend.
 *
 * Legacy fed its shaders the window's pointer and scroll speed; morph does the same by
 * itself, with legacy's easing in per-60fps-frame terms, so the effects work with no wiring.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { comice } from 'comice'
import { getSharedScheduler } from 'comice/scheduler'
import { morph } from '../packages/morph/src/index.js'
import { trackWindowInput } from '../packages/morph/src/window-input.js'
import { createFakeGL2, installFake2DContext } from './fake-webgl2.js'
import { installFakeIntersectionObserver } from './fake-intersection.js'

const originalMatchMedia = globalThis.matchMedia
const originalNow = performance.now.bind(performance)
let now = 0
let scrolled = 0

function setHover(hover: boolean): void {
  globalThis.matchMedia = ((query: string) => ({ matches: hover && query.includes('hover: hover'), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false, onchange: null })) as unknown as typeof matchMedia
}
function move(x: number, y: number): void {
  window.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y }))
}
function scrollBy(px: number, ms: number): void {
  now += ms
  scrolled += px
  window.dispatchEvent(new Event('scroll'))
}
const settle = (input: ReturnType<typeof trackWindowInput>, frames: number, ms = 16.67) => { for (let i = 0; i < frames; i++) input.tick(ms) }

beforeEach(() => {
  now = 1000
  scrolled = 0
  performance.now = () => now
  Object.defineProperty(window, 'scrollY', { configurable: true, get: () => scrolled })
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 })
  setHover(true)
})
afterEach(() => {
  performance.now = originalNow
  globalThis.matchMedia = originalMatchMedia
})

describe('trackWindowInput: the pointer', () => {
  it('starts centred and eases toward the pointer over the window (y up)', () => {
    const input = trackWindowInput({ pointer: true, scroll: false })
    expect([input.mouseX, input.mouseY]).toEqual([0, 0])
    move(1000, 0) // the top-right corner: x 1, y 1
    input.tick(16.67)
    expect(input.mouseX).toBeCloseTo(.05, 3) // legacy's .05 of the way each frame
    expect(input.mouseY).toBeCloseTo(.05, 3)
    settle(input, 200)
    expect(input.mouseX).toBeCloseTo(1, 2)
    expect(input.mouseY).toBeCloseTo(1, 2)
    move(0, 800) // bottom-left: -1, -1
    settle(input, 300)
    expect([input.mouseX, input.mouseY]).toEqual([-1, -1])
    input.destroy()
  })

  it('is the same speed at any refresh rate: two half-frames ease like one frame', () => {
    const a = trackWindowInput({ pointer: true, scroll: false }), b = trackWindowInput({ pointer: true, scroll: false })
    move(1000, 400)
    a.tick(16.67)
    b.tick(8.335); b.tick(8.335)
    expect(b.mouseX).toBeCloseTo(a.mouseX, 3)
    a.destroy(); b.destroy()
  })

  it('a stalled frame is capped, not a leap', () => {
    const input = trackWindowInput({ pointer: true, scroll: false })
    move(1000, 400)
    input.tick(5000)
    expect(input.mouseX).toBeLessThan(.2)
    input.destroy()
  })

  it('is ignored without a hover-capable pointer (touch)', () => {
    setHover(false)
    const input = trackWindowInput({ pointer: true, scroll: false })
    move(1000, 0); settle(input, 100)
    expect([input.mouseX, input.mouseY]).toEqual([0, 0])
    input.destroy()
  })

  it('is ignored when asked not to follow', () => {
    const input = trackWindowInput({ pointer: false, scroll: false })
    move(1000, 0); settle(input, 100)
    expect(input.mouseX).toBe(0)
    input.destroy()
  })

  it('works where matchMedia does not exist', () => {
    ;(globalThis as { matchMedia?: unknown }).matchMedia = undefined
    const input = trackWindowInput({ pointer: true, scroll: false })
    move(1000, 0); settle(input, 100)
    expect(input.mouseX).toBe(0)
    input.destroy()
  })
})

describe('trackWindowInput: the scroll speed', () => {
  it('rises toward 1 with fast scrolling, in legacy\'s px/s over 2000, and falls back to exactly 0', () => {
    const input = trackWindowInput({ pointer: false, scroll: true })
    expect(input.velocity).toBe(0)
    scrollBy(10, 1000) // the first event after a long pause has no interval to measure
    scrollBy(100, 16.67) // 6000 px/s
    input.tick(16.67)
    expect(input.velocity).toBeCloseTo(.08, 2)
    for (let i = 0; i < 30; i++) { scrollBy(100, 16.67); input.tick(16.67) }
    expect(input.velocity).toBeGreaterThan(.8)
    expect(input.velocity).toBeLessThanOrEqual(1)
    settle(input, 600)
    expect(input.velocity).toBe(0)
    input.destroy()
  })

  it('is signed: scrolling up bends the other way', () => {
    const input = trackWindowInput({ pointer: false, scroll: true })
    scrollBy(0, 1000)
    for (let i = 0; i < 30; i++) { scrollBy(-80, 16.67); input.tick(16.67) }
    expect(input.velocity).toBeLessThan(-.5)
    input.destroy()
  })

  it('slow scrolling is a small fraction, not a full bend', () => {
    const input = trackWindowInput({ pointer: false, scroll: true })
    scrollBy(0, 1000)
    for (let i = 0; i < 60; i++) { scrollBy(4, 16.67); input.tick(16.67) } // 240 px/s
    expect(input.velocity).toBeGreaterThan(0)
    expect(input.velocity).toBeLessThan(.2)
    input.destroy()
  })

  it('ignores events too close together to give a speed', () => {
    const input = trackWindowInput({ pointer: false, scroll: true })
    scrollBy(0, 1000)
    scrollBy(5000, .0001)
    input.tick(16.67)
    expect(input.velocity).toBe(0)
    input.destroy()
  })

  it('is ignored when asked not to bend', () => {
    const input = trackWindowInput({ pointer: false, scroll: false })
    scrollBy(0, 1000); scrollBy(500, 16.67); input.tick(16.67)
    expect(input.velocity).toBe(0)
    input.destroy()
  })
})

describe('trackWindowInput: settle', () => {
  it('drops the scroll speed to rest but keeps the pointer where it was', () => {
    const input = trackWindowInput({ pointer: true, scroll: true })
    move(1000, 0)
    scrollBy(0, 1000)
    for (let i = 0; i < 30; i++) { scrollBy(100, 16.67); input.tick(16.67) }
    expect(input.velocity).toBeGreaterThan(.5)
    const x = input.mouseX
    input.settle()
    expect(input.velocity).toBe(0)
    input.tick(16.67)
    expect(input.velocity).toBe(0) // the raw speed went with it
    expect(input.mouseX).toBeGreaterThanOrEqual(x)
    input.destroy()
  })
})

describe('trackWindowInput: teardown', () => {
  it('destroy removes both listeners', () => {
    const input = trackWindowInput({ pointer: true, scroll: true })
    input.destroy()
    move(1000, 0)
    scrollBy(0, 1000); scrollBy(900, 16.67)
    settle(input, 50)
    expect([input.mouseX, input.mouseY, input.velocity]).toEqual([0, 0, 0])
    expect(() => input.destroy()).not.toThrow()
  })
})

describe('morph: cursorFollow and bend work with no wiring', () => {
  let observer: ReturnType<typeof installFakeIntersectionObserver>
  let raster: ReturnType<typeof installFake2DContext>
  const originalGetContext = HTMLCanvasElement.prototype.getContext
  const originalRaf = globalThis.requestAnimationFrame
  let tick: FrameRequestCallback = () => {}
  let frameAt = 0

  beforeEach(() => {
    getSharedScheduler().stop()
    raster = installFake2DContext()
    const rasterContext = HTMLCanvasElement.prototype.getContext
    observer = installFakeIntersectionObserver()
    const gl = createFakeGL2()
    HTMLCanvasElement.prototype.getContext = function (type: string, ...rest: unknown[]) { return type === 'webgl2' ? gl : rasterContext.call(this, type as never, ...rest as never[]) } as typeof originalGetContext
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => { tick = cb; return 1 }) as typeof requestAnimationFrame
    frameAt = 0
  })
  afterEach(() => {
    getSharedScheduler().stop()
    observer.uninstall()
    raster.uninstall()
    HTMLCanvasElement.prototype.getContext = originalGetContext
    globalThis.requestAnimationFrame = originalRaf
    document.body.innerHTML = ''
  })

  function mount(options: Parameters<typeof morph>[0]) {
    const image = document.createElement('img')
    Object.defineProperties(image, { complete: { value: true }, naturalWidth: { value: 40 }, naturalHeight: { value: 20 } })
    Object.defineProperty(image, 'getBoundingClientRect', { value: () => ({ left: 0, top: 0, width: 40, height: 20, right: 40, bottom: 20 }) })
    document.body.append(image)
    const effect = morph(options)
    const handle = comice(image).use(effect)
    return { effect, handle }
  }
  const frames = (n: number) => { for (let i = 0; i < n; i++) tick((frameAt += 16.67)) }
  const drain = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }

  it('the media follows the pointer by default, eased, with nothing mapped', async () => {
    const { effect, handle } = mount({ to: 'circle(40%)' })
    await drain(); frames(2)
    expect(effect.params!.getParam('mouseX')).toBe(0)
    move(1000, 0)
    frames(120)
    expect(effect.params!.getParam('mouseX')).toBeGreaterThan(.9)
    expect(effect.params!.getParam('mouseY')).toBeGreaterThan(.9)
    handle.destroy()
  })

  it('the shape bends with the page\'s scroll speed when bend is on', async () => {
    const { effect, handle } = mount({ to: 'circle(40%)', bend: true })
    await drain(); frames(2)
    scrollBy(0, 1000)
    for (let i = 0; i < 30; i++) { scrollBy(100, 16.67); frames(1) }
    expect(effect.params!.getParam('velocity')).toBeGreaterThan(.5)
    frames(600)
    expect(effect.params!.getParam('velocity')).toBe(0)
    handle.destroy()
  })

  it('an effect that was not ticking (off screen) comes back at rest, not bent by a stale speed', async () => {
    const { effect, handle } = mount({ to: 'circle(40%)', bend: true })
    await drain(); frames(2)
    scrollBy(0, 1000)
    for (let i = 0; i < 30; i++) { scrollBy(100, 16.67); frames(1) }
    expect(effect.params!.getParam('velocity')).toBeGreaterThan(.5)
    now += 5000 // scrolled away, nothing ticked, and the page's speed died down long ago
    frames(1)
    expect(effect.params!.getParam('velocity')).toBe(0)
    handle.destroy()
  })

  it('without bend, scrolling does not move the velocity channel', async () => {
    const { effect, handle } = mount({ to: 'circle(40%)' })
    await drain(); frames(2)
    scrollBy(0, 1000)
    for (let i = 0; i < 30; i++) { scrollBy(100, 16.67); frames(1) }
    expect(effect.params!.getParam('velocity')).toBe(0)
    handle.destroy()
  })

  it('cursorFollow: false listens to nothing', async () => {
    const { effect, handle } = mount({ to: 'circle(40%)', cursorFollow: false })
    await drain(); frames(2)
    move(1000, 0); frames(60)
    expect(effect.params!.getParam('mouseX')).toBe(0)
    handle.destroy()
  })

  it('driving a channel yourself takes it over, and only that channel', async () => {
    const { effect, handle } = mount({ to: 'circle(40%)', bend: true })
    await drain(); frames(2)
    effect.params!.setParam('mouseX', -.5) // a mapping, say
    move(1000, 0); frames(120)
    expect(effect.params!.getParam('mouseX')).toBe(-.5) // not overwritten by the pointer
    expect(effect.params!.getParam('mouseY')).toBeGreaterThan(.9) // the other axis still follows
    effect.params!.setParam('velocity', .3)
    scrollBy(0, 1000)
    for (let i = 0; i < 20; i++) { scrollBy(100, 16.67); frames(1) }
    expect(effect.params!.getParam('velocity')).toBe(.3)
    handle.destroy()
  })

  it('destroying removes the window listeners', async () => {
    const { effect, handle } = mount({ to: 'circle(40%)', bend: true })
    await drain(); frames(2)
    handle.destroy()
    move(1000, 0)
    expect(() => frames(5)).not.toThrow()
    expect(effect.params!.getParam('mouseX')).toBe(0)
  })
})

describe('morph: the cursor-follow zoom eases in after the handoff', () => {
  const originalGetContext = HTMLCanvasElement.prototype.getContext
  const originalRaf = globalThis.requestAnimationFrame
  let raster: ReturnType<typeof installFake2DContext>
  let observer: ReturnType<typeof installFakeIntersectionObserver>
  let uniform1f: Array<[unknown, number]> = []
  let tick: FrameRequestCallback = () => {}
  let frameAt = 0

  beforeEach(() => {
    getSharedScheduler().stop()
    raster = installFake2DContext()
    const realWithFake2D = HTMLCanvasElement.prototype.getContext
    observer = installFakeIntersectionObserver()
    const gl = createFakeGL2()
    uniform1f = []
    const original = gl.uniform1f.bind(gl)
    gl.uniform1f = ((location: unknown, value: number) => { uniform1f.push([location, value]); return original(location as never, value) }) as typeof gl.uniform1f
    const locations = new Map<string, unknown>()
    gl.getUniformLocation = ((program: unknown, name: string) => { if (!locations.has(name)) locations.set(name, { name }); return locations.get(name) as never }) as typeof gl.getUniformLocation
    HTMLCanvasElement.prototype.getContext = function (type: string, ...rest: unknown[]) { return type === 'webgl2' ? gl : realWithFake2D.call(this, type as never, ...rest as never[]) } as typeof originalGetContext
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => { tick = cb; return 1 }) as typeof requestAnimationFrame
    frameAt = 0
  })
  afterEach(() => {
    getSharedScheduler().stop()
    observer.uninstall()
    raster.uninstall()
    HTMLCanvasElement.prototype.getContext = originalGetContext
    globalThis.requestAnimationFrame = originalRaf
    document.body.innerHTML = ''
  })

  const follow = () => uniform1f.filter(([location]) => (location as { name?: string }).name === 'u_follow').map(([, value]) => value)
  const frames = (n: number, ms = 16.67) => { for (let i = 0; i < n; i++) tick((frameAt += ms)) }
  const drain = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
  function mount(options: Parameters<typeof morph>[0]) {
    const image = document.createElement('img')
    Object.defineProperties(image, { complete: { value: true }, naturalWidth: { value: 40 }, naturalHeight: { value: 20 } })
    Object.defineProperty(image, 'getBoundingClientRect', { value: () => ({ left: 0, top: 0, width: 40, height: 20, right: 40, bottom: 20 }) })
    document.body.append(image)
    const effect = morph(options)
    return { effect, handle: comice(image).use(effect) }
  }

  it('starts at 0, so the canvas shows exactly what the media showed, then eases to 1 once the handoff is done', async () => {
    const { effect, handle } = mount({ to: 'circle(40%)' })
    await drain()
    handle.set(effect, { progress: 0 })
    frames(2)
    const first = follow()
    expect(first.length).toBeGreaterThan(0)
    expect(first[0]).toBe(0) // the handoff frame: a zoom of 1 and no offset
    // Still 0 while the canvas fades in over the media.
    now = 1000
    performance.now = () => 1000 + 100
    frames(3)
    expect(follow().at(-1)).toBe(0)
    // Then it eases in, and settles at exactly 1.
    performance.now = () => 1000 + 280 + 450
    frames(2)
    expect(follow().at(-1)!).toBeGreaterThan(0)
    expect(follow().at(-1)!).toBeLessThan(1)
    performance.now = () => 1000 + 280 + 5000
    frames(2)
    expect(follow().at(-1)).toBe(1)
    handle.destroy()
  })

  it('under reduced motion it stays at 0: no parallax, so no margin to need', async () => {
    globalThis.matchMedia = ((query: string) => ({ matches: query.includes('prefers-reduced-motion'), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false, onchange: null })) as unknown as typeof matchMedia
    const { effect, handle } = mount({ to: 'circle(40%)' })
    await drain()
    handle.set(effect, { progress: .5 })
    performance.now = () => 1000 + 99999
    frames(3)
    expect(follow().every((value) => value === 0)).toBe(true)
    handle.destroy()
  })

  it('without cursorFollow there is no zoom to ease', async () => {
    const { effect, handle } = mount({ to: 'circle(40%)', cursorFollow: false })
    await drain()
    handle.set(effect, { progress: .5 })
    frames(2)
    expect(follow().length).toBeGreaterThan(0) // the uniform is still set (to 1), and the shader ignores it
    handle.destroy()
  })
})
