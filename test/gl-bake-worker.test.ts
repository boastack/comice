/**
 * test/gl-bake-worker — background shape bakes (core's gl/mask.ts).
 *
 * A morph demo scrolling into view used to bake its masks (a distance
 * transform over millions of pixels, plus finding the islands) on the main
 * thread: 50 long tasks and 22s of blocking over one scroll of the demo page,
 * the worst over a second. `background: true` runs that on a worker built
 * from the same functions, and these pin it: the packed half floats, the
 * inline fallback, obsolete bakes being dropped, and the real worker source.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { bakeMask, createRasterizedMask, resetBakeWorker, smoothFar, toHalf } from '../packages/core/src/gl/mask.js'
import { mountCanvas } from '../packages/core/src/gl/context.js'
import { createFakeGLContext, installFake2DContext } from './fake-webgl2.js'

let raster: ReturnType<typeof installFake2DContext>
beforeEach(() => { resetBakeWorker(); raster = installFake2DContext() })
afterEach(() => { raster.uninstall(); resetBakeWorker(); document.body.innerHTML = '' })

function rig() {
  const context = createFakeGLContext(document.createElement('canvas'))
  const uploads: unknown[][] = []
  context.gl.texImage2D = ((...args: unknown[]) => { uploads.push(args) }) as typeof context.gl.texImage2D
  return { context, uploads, mask: createRasterizedMask(context) }
}
const text = { type: 'text' as const, text: 'Shape' }

describe('toHalf', () => {
  it('packs float32 into IEEE half bit patterns, rounding to nearest', () => {
    expect([...toHalf(new Float32Array([0, 1, -2, 0.5, 65504, 0.1]))]).toEqual([0, 0x3c00, 0xc000, 0x3800, 0x7bff, 0x2e66])
  })
  it('rounding up just below a power of two carries into the exponent', () => {
    const decode = (h: number) => { const e = (h >> 10) & 31, m = h & 1023, sign = h & 0x8000 ? -1 : 1; return sign * (e ? (1 + m / 1024) * 2 ** (e - 15) : m * 2 ** -24) }
    for (let e = -10; e <= 15; e++) {
      const just = 2 ** e * (1 - 2 ** -14) // rounds up to 2^e in half precision
      const [up, down] = toHalf(new Float32Array([just, -just]))
      expect(decode(up!)).toBe(2 ** e)
      expect(decode(down!)).toBe(-(2 ** e))
    }
    expect(toHalf(new Float32Array([65519]))[0]).toBe(0x7bff) // still the largest finite half
    expect(toHalf(new Float32Array([65520]))[0]).toBe(0x7c00) // the carry overflows to infinity
  })

  it('decodes back within half precision across the whole range a field uses', () => {
    const decode = (h: number) => { const e = (h >> 10) & 31, m = h & 1023, sign = h & 0x8000 ? -1 : 1; return sign * (e ? (1 + m / 1024) * 2 ** (e - 15) : m * 2 ** -24) }
    for (let v = -2048; v <= 2048; v += 0.37) {
      const back = decode(toHalf(new Float32Array([v]))[0]!)
      expect(Math.abs(back - v)).toBeLessThanOrEqual(Math.max(Math.abs(v) * 2 ** -11, 2 ** -24) + 1e-9)
    }
  })

  it('saturates overflow to infinity, keeps subnormals and flushes the tiniest to zero', () => {
    const [big, negBig, sub, tiny] = toHalf(new Float32Array([1e6, -1e6, 3e-5, 1e-9]))
    expect(big).toBe(0x7c00)
    expect(negBig).toBe(0xfc00)
    expect(sub).toBeGreaterThan(0)
    expect(sub).toBeLessThan(0x0400)
    expect(tiny).toBe(0)
  })
})

describe('bakeMask', () => {
  const pixels = (alphas: number[]) => { const data = new Uint8ClampedArray(alphas.length * 4); alphas.forEach((a, i) => { data[i * 4 + 3] = a }); return data.buffer }
  const job = (over: Partial<Parameters<typeof bakeMask>[0]>) => ({ id: 1, width: 4, height: 1, pixels: pixels([255, 0, 0, 255]), sdf: true, maxDistance: 8, threshold: 96, half: false, bounded: false, components: false, ...over })

  it('finds the islands without an SDF when only components are asked for', () => {
    const result = bakeMask(job({ sdf: false, components: true, width: 9, height: 1, pixels: pixels([255, 255, 0, 0, 0, 0, 0, 255, 255]) }))
    expect(result.field).toBeNull()
    expect(result.components.length).toBe(2)
  })
  it('returns byte fields as bytes, and half fields packed as 16-bit halves', () => {
    const bytes = bakeMask(job({}))
    expect(bytes.packed).toBe(false)
    expect(new Uint8Array(bytes.field!).length).toBe(4)
    const halves = bakeMask(job({ half: true }))
    expect(halves.packed).toBe(true)
    expect(new Uint16Array(halves.field!).length).toBe(4)
  })
})

describe('background rasterize', () => {
  it('without a worker: bakes inline, uploads packed halves, and keeps the old field until then', async () => {
    const { mask, uploads, context } = rig()
    const done = mask.rasterize(text, 30, 20, { sdf: true, precision: 'half', maxDistance: 30, background: true, components: true })
    expect(done).toBeInstanceOf(Promise)
    expect(mask.field).toBeNull()
    expect(await done).toBe(true)
    expect(mask.field?.kind).toBe('texture')
    const upload = uploads.at(-1)!
    expect(upload[2]).toBe(context.gl.R16F)
    expect(upload[7]).toBe(context.gl.HALF_FLOAT)
    expect(upload[8]).toBeInstanceOf(Uint16Array)
    expect(mask.distanceEncoding).toBe('signed')
    expect(mask.components).toEqual([[0.5, 0.5]])
  })

  it('byte fields upload as bytes; a components-only bake uploads the coverage', async () => {
    const { mask, uploads, context } = rig()
    expect(await mask.rasterize(text, 8, 8, { sdf: true, background: true })).toBe(true)
    expect(uploads.at(-1)![7]).toBe(context.gl.UNSIGNED_BYTE)
    expect(uploads.at(-1)![8]).toBeInstanceOf(Uint8Array)
    expect(await mask.rasterize(text, 8, 8, { components: true, background: true })).toBe(true)
    expect(uploads.at(-1)!.length).toBe(6) // texImage2D(target, level, internal, format, type, canvas)
    expect(mask.components).toEqual([[0.5, 0.5]])
  })

  it('a later rasterize() or a destroy() makes an earlier bake obsolete', async () => {
    const { mask } = rig()
    const first = mask.rasterize(text, 8, 8, { sdf: true, background: true })
    const second = mask.rasterize(text, 9, 9, { sdf: true, background: true })
    expect(await first).toBe(false)
    expect(await second).toBe(true)
    const third = mask.rasterize(text, 10, 10, { sdf: true, background: true })
    mask.destroy()
    expect(await third).toBe(false)
  })

  it('a plain rasterize() (no background) stays synchronous', () => {
    const { mask } = rig()
    expect(mask.rasterize(text, 8, 8, { sdf: true })).toBeUndefined()
    expect(mask.field).not.toBeNull()
  })
})

describe('the bake worker', () => {
  const OriginalBlob = globalThis.Blob
  let built = 0
  let sources: string[] = []
  afterEach(() => { globalThis.Blob = OriginalBlob; (globalThis as { Worker?: unknown }).Worker = undefined })

  /** A Worker that runs the real generated source, as a browser would. */
  function installWorker(behaviour: 'run' | 'fail' | 'throw' = 'run') {
    built = 0
    sources = []
    globalThis.Blob = class extends OriginalBlob {
      constructor(parts: BlobPart[], options?: BlobPropertyBag) { super(parts, options); sources.push(parts.join('')) }
    } as typeof Blob
    ;(globalThis as { Worker?: unknown }).Worker = class {
      onmessage: ((event: { data: unknown }) => void) | null = null
      onerror: (() => void) | null = null
      private scope: { onmessage?: (event: { data: unknown }) => void; postMessage(data: unknown): void }
      constructor() {
        if (behaviour === 'throw') throw new Error('blocked by CSP')
        built++
        this.scope = { postMessage: (data) => setTimeout(() => this.onmessage?.({ data }), 0) }
        new Function('self', sources.at(-1)!)(this.scope)
      }
      postMessage(data: unknown) {
        if (behaviour === 'fail') { setTimeout(() => this.onerror?.(), 0); return }
        setTimeout(() => this.scope.onmessage!({ data }), 0)
      }
      terminate() {}
    }
  }

  it('runs the generated source off the main thread and shares one worker', async () => {
    installWorker()
    const a = rig(), b = rig()
    const [doneA, doneB] = [a.mask.rasterize(text, 12, 12, { sdf: true, precision: 'half', background: true }), b.mask.rasterize(text, 12, 12, { sdf: true, background: true, components: true })]
    expect(await doneA).toBe(true)
    expect(await doneB).toBe(true)
    expect(built).toBe(Math.max(1, Math.min(2, (navigator.hardwareConcurrency ?? 2) - 1)))
    expect(a.uploads.at(-1)![8]).toBeInstanceOf(Uint16Array)
    expect(b.mask.components).toEqual([[0.5, 0.5]])
  })

  it('a failing worker hands its bakes back to the main thread, and later bakes stay there', async () => {
    installWorker('fail')
    const { mask } = rig()
    expect(await mask.rasterize(text, 8, 8, { sdf: true, background: true })).toBe(true)
    const workers = built
    expect(await mask.rasterize(text, 9, 9, { sdf: true, background: true })).toBe(true)
    expect(built).toBe(workers)
  })

  it('a worker that cannot be created (a strict CSP) means inline bakes', async () => {
    installWorker('throw')
    const { mask } = rig()
    expect(await mask.rasterize(text, 8, 8, { sdf: true, background: true })).toBe(true)
  })
})

describe('mountCanvas: hideTarget()', () => {
  it('a canvas mounted over visible media hides it once it has drawn, and release restores it', () => {
    const img = document.createElement('img'); img.style.visibility = 'visible'; document.body.append(img)
    const mount = mountCanvas(createFakeGLContext(document.createElement('canvas')), img, { owner: 'test', hideTarget: false })
    expect(img.style.visibility).toBe('visible')
    mount.hideTarget(); mount.hideTarget()
    expect(img.style.visibility).toBe('hidden')
    mount.release()
    expect(img.style.visibility).toBe('visible')
    mount.hideTarget()
    expect(img.style.visibility).toBe('visible')
  })
})

describe('the worker pool size', () => {
  const descriptor = Object.getOwnPropertyDescriptor(Navigator.prototype, 'hardwareConcurrency') ?? Object.getOwnPropertyDescriptor(navigator, 'hardwareConcurrency')
  afterEach(() => { if (descriptor) Object.defineProperty(navigator, 'hardwareConcurrency', descriptor); (globalThis as { Worker?: unknown }).Worker = undefined })
  for (const [cores, expected] of [[1, 1], [2, 1], [8, 2], [undefined, 1]] as const) {
    it(`${cores ?? 'unknown'} cores -> ${expected} worker(s)`, async () => {
      Object.defineProperty(navigator, 'hardwareConcurrency', { value: cores, configurable: true })
      let made = 0
      ;(globalThis as { Worker?: unknown }).Worker = class { onmessage: unknown; onerror: unknown; constructor() { made++ } postMessage(job: { id: number }) { setTimeout(() => (this.onmessage as (e: unknown) => void)({ data: bakeMask(job as never) }), 0) } terminate() {} }
      const { mask } = rig()
      expect(await mask.rasterize(text, 8, 8, { sdf: true, background: true })).toBe(true)
      expect(made).toBe(expected)
    })
  }
})

describe('mountCanvas: the handoff from the media to the canvas', () => {
  function animations(el: HTMLElement, log: string[]) {
    const made: Array<{ onfinish: null | (() => void); cancel: () => void }> = []
    ;(el as unknown as { animate: unknown }).animate = (frames: Keyframe[]) => {
      log.push(`${el.tagName}:${frames[0]!.opacity}->${frames[1]!.opacity}`)
      const animation = { onfinish: null as null | (() => void), cancel: () => log.push('cancel') }
      made.push(animation); return animation
    }
    return made
  }
  const rig = (hideTarget = false) => {
    const img = document.createElement('img'); img.style.visibility = 'visible'; document.body.append(img)
    const context = createFakeGLContext(document.createElement('canvas'))
    const log: string[] = []
    const canvasAnimations = animations(context.canvas, log)
    animations(img, log)
    return { img, log, canvasAnimations, mount: mountCanvas(context, img, { owner: 'test', hideTarget }) }
  }

  it('fades the canvas in over the media, which stays fully opaque until the canvas is in', () => {
    const { img, log, canvasAnimations, mount } = rig()
    mount.hideTarget(280)
    expect(log).toEqual(['CANVAS:0->1']) // the media is not faded at all
    expect(img.style.visibility).toBe('visible')
    canvasAnimations[0]!.onfinish!()
    expect(img.style.visibility).toBe('hidden')
    mount.release()
    expect(img.style.visibility).toBe('visible')
  })

  it('hands over once: a second call does nothing', () => {
    const { log, mount } = rig()
    mount.hideTarget(280); mount.hideTarget(280); mount.hideTarget()
    expect(log).toEqual(['CANVAS:0->1'])
  })

  it('without a fade (or without Web Animations) the media is hidden at once', () => {
    const instant = rig(); instant.mount.hideTarget(0)
    expect(instant.img.style.visibility).toBe('hidden')
    const plain = document.createElement('img'); document.body.append(plain)
    const context = createFakeGLContext(document.createElement('canvas'))
    const mount = mountCanvas(context, plain, { owner: 'test', hideTarget: false })
    mount.hideTarget(280) // happy-dom has no element.animate here
    expect(plain.style.visibility).toBe('hidden')
  })

  it('release mid-fade cancels it and never hides the media afterwards', () => {
    const { img, log, canvasAnimations, mount } = rig()
    mount.hideTarget(280)
    mount.release()
    expect(log.filter((entry) => entry === 'cancel')).toHaveLength(1)
    canvasAnimations[0]!.onfinish!()
    expect(img.style.visibility).toBe('visible')
  })

  it('holdTarget keeps the media hidden (or shown) under the empty canvas until the handoff', () => {
    const { img, mount } = rig()
    mount.holdTarget(false)
    expect(img.style.visibility).toBe('hidden')
    mount.holdTarget(true)
    expect(img.style.visibility).toBe('visible')
    mount.holdTarget(true) // already shown: nothing to restore
    mount.holdTarget(false)
    expect(img.style.visibility).toBe('hidden')
    mount.release()
    expect(img.style.visibility).toBe('visible') // the app's own value comes back
  })

  it('a canvas that arrives while the media is held hidden fades in from empty', () => {
    const { img, log, mount } = rig()
    mount.holdTarget(false)
    mount.hideTarget(280)
    expect(log).toEqual(['CANVAS:0->1'])
    expect(img.style.visibility).toBe('hidden')
    const instant = rig(); instant.mount.holdTarget(false); instant.mount.hideTarget(0)
    expect(instant.log).toEqual([])
  })

  it('holdTarget does nothing after the handoff or release', () => {
    const { img, mount } = rig()
    mount.hideTarget(0)
    mount.holdTarget(true)
    expect(img.style.visibility).toBe('hidden')
    const second = rig(); second.mount.release(); second.mount.holdTarget(false)
    expect(second.img.style.visibility).toBe('visible')
  })

  it('completeReveal finishes a fade that is still running, and does nothing otherwise', () => {
    const { img, log, mount } = rig()
    mount.completeReveal() // nothing to finish yet
    expect(img.style.visibility).toBe('visible')
    mount.hideTarget(280)
    mount.completeReveal()
    expect(log).toEqual(['CANVAS:0->1', 'cancel'])
    expect(img.style.visibility).toBe('hidden')
    mount.completeReveal() // done already
    expect(log).toHaveLength(2)
    const released = rig(); released.mount.hideTarget(280); released.mount.release(); released.mount.completeReveal()
    expect(released.img.style.visibility).toBe('visible')
  })

  it('an effect that hides the media from the start is not affected', () => {
    const { img, mount } = rig(true)
    expect(img.style.visibility).toBe('hidden')
    mount.hideTarget(0)
    mount.release()
    expect(img.style.visibility).toBe('visible')
  })
})

describe('smoothFar', () => {
  it('keeps the field exact near the edge and rounds off creases far from it', () => {
    const W = 200, H = 100
    // Two points' distance field: a sharp ridge down the middle, far from both.
    const field = new Float32Array(W * H)
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) field[y * W + x] = Math.min(Math.hypot(x - 40, y - 50), Math.hypot(x - 160, y - 50)) - 3
    const original = field.slice()
    smoothFar(field, W, H)
    for (let i = 0; i < field.length; i++) if (Math.abs(original[i]!) <= 6) expect(field[i]).toBe(original[i])
    // The ridge at x = 100 is no longer a kink: its second difference shrinks.
    const kink = (f: Float32Array) => Math.abs(f[50 * W + 99]! - 2 * f[50 * W + 100]! + f[50 * W + 101]!)
    expect(kink(field)).toBeLessThan(kink(original) / 2)
    // Never flips a sign, so the shape cannot change.
    for (let i = 0; i < field.length; i++) expect(Math.sign(field[i]!) === Math.sign(original[i]!) || original[i] === 0).toBe(true)
  })
})

describe('edge coverage', () => {
  it('a faint sliver of coverage far from the shape is a distance, not an edge', () => {
    const W = 40, H = 1
    const data = new Uint8ClampedArray(W * H * 4)
    for (let x = 0; x < 4; x++) data[x * 4 + 3] = 255 // the shape
    data[30 * 4 + 3] = 40 // a stray, faint pixel far away
    data[4 * 4 + 3] = 40 // a faint pixel on the real edge
    const result = bakeMask({ id: 1, width: W, height: H, pixels: data.buffer, sdf: true, maxDistance: 64, threshold: 96, half: true, bounded: false, components: false })
    const decode = (h: number) => { const e = (h >> 10) & 31, m = h & 1023, s = h & 0x8000 ? -1 : 1; return s * (e ? (1 + m / 1024) * 2 ** (e - 15) : m * 2 ** -24) }
    const values = [...new Uint16Array(result.field!)].map(decode)
    expect(values[4]).toBeCloseTo((96 - 40) / 255, 2) // edge keeps its fractional coverage
    expect(values[30]).toBeGreaterThan(20) // the stray pixel reads as far outside
  })
})
