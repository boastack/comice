/**
 * test/distort-effects — distort's five remaining effects (spec §08)
 * ─────────────────────────────────────────────────────────────────────────────
 * The card lists eight effects; three were built. ripple, smear,
 * shapedLens, tear and liquid now exist — liquid with real momentum, kept
 * in core's temporal feedback buffer (its first consumer). Rendering is
 * verified in Chromium; these pin the GLSL, the liquid field, and the
 * per-frame wiring.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { comice, type ComiceHandle, type ComiceEvent, type Driver, type DriverSignal } from 'comice'
import { getSharedScheduler } from 'comice/scheduler'
import { distort } from '../packages/distort/src/index.js'
import { createLiquidField } from '../packages/distort/src/liquid.js'
import { compileDistortProgram, drawDistort, type DistortEffect } from '../packages/distort/src/shader.js'
import { getResidencyPool } from '../packages/core/src/gl/residency.js'
import type { Plane } from '../packages/core/src/gl/plane.js'
import { createFakeGL2, createFakeGLContext, type FakeGLOptions } from './fake-webgl2.js'
import { installFakeIntersectionObserver, type FakeIntersection } from './fake-intersection.js'

function fragmentSource(effect: DistortEffect): string {
  const context = createFakeGLContext(document.createElement('canvas'))
  const sources: string[] = []
  const shaderSource = context.gl.shaderSource.bind(context.gl)
  context.gl.shaderSource = (shader: WebGLShader, source: string) => {
    sources.push(source)
    shaderSource(shader, source)
  }
  compileDistortProgram(context.gl, { effect, falloff: 'linear' })
  return sources.find((s) => s.includes('u_pointer')) ?? ''
}

describe('the five new effects, in GLSL', () => {
  it('ripple: rings of sin(distance - time), ramped in from the pointer (no pinch under the cursor)', () => {
    const s = fragmentSource('ripple')
    expect(s).toContain('sin(d * 18.0 - u_time * 6.0)')
    expect(s).toContain('float ramp = smoothstep(0.0, 0.35, d);')
  })

  it('smear: samples reach back against the pointer velocity', () => {
    expect(fragmentSource('smear')).toContain('uv - u_velocity * field * 8.0')
  })

  it('shapedLens: a squircle edge (|x|^4 + |y|^4), not a circle', () => {
    expect(fragmentSource('shapedLens')).toContain('pow(pow(q.x, 4.0) + pow(q.y, 4.0), 0.25)')
  })

  it('tear: a ragged gap through the pointer that shows the page behind', () => {
    const s = fragmentSource('tear')
    expect(s).toContain('if (abs(y) < gap)')
    expect(s).toContain('outColor = vec4(0.0);')
  })

  it('liquid: displaced by the field texture', () => {
    expect(fragmentSource('liquid')).toContain('texture(u_field, uv).rg - 0.5')
  })
})

describe('drawDistort with a liquid field', () => {
  const plane = { texture: {} as WebGLTexture } as unknown as Plane

  it('binds the field to its own unit', () => {
    const context = createFakeGLContext(document.createElement('canvas'))
    const program = compileDistortProgram(context.gl, { effect: 'liquid' })!
    const bound: number[] = []
    const uniform1i = context.gl.uniform1i.bind(context.gl)
    context.gl.uniform1i = (loc: WebGLUniformLocation | null, v: number) => {
      if ((loc as unknown as { __id: string } | null)?.__id === 'u_field') bound.push(v)
      uniform1i(loc, v)
    }
    getResidencyPool(context).beginPass()
    drawDistort(context, program, plane, { pointerX: 0, pointerY: 0, pointerActive: true, radius: 0.3, strength: 0.5, refraction: 0, resolutionWidth: 300, resolutionHeight: 200, fieldTexture: {} as WebGLTexture })
    expect(bound).toHaveLength(1)
  })

  it('with no unit to spare, still draws (the field just stays unbound)', () => {
    const context = createFakeGLContext(document.createElement('canvas'), { maxTextureUnits: 1 })
    const program = compileDistortProgram(context.gl, { effect: 'liquid' })!
    getResidencyPool(context).beginPass()
    expect(() => drawDistort(context, program, plane, { pointerX: 0, pointerY: 0, pointerActive: true, radius: 0.3, strength: 0.5, refraction: 0, resolutionWidth: 300, resolutionHeight: 200, fieldTexture: {} as WebGLTexture })).not.toThrow()
  })
})

describe('createLiquidField', () => {
  function context(options: FakeGLOptions = {}) {
    const ctx = createFakeGLContext(document.createElement('canvas'), options)
    const viewports: number[][] = []
    const clears: number[][] = []
    Object.defineProperty(ctx.gl, 'drawingBufferWidth', { value: 1200 })
    Object.defineProperty(ctx.gl, 'drawingBufferHeight', { value: 800 })
    ctx.gl.viewport = (x: number, y: number, w: number, h: number) => void viewports.push([x, y, w, h])
    ctx.gl.clearColor = (r: number, g: number, b: number, a: number) => void clears.push([r, g, b, a])
    return { ctx, viewports, clears }
  }
  const state = { pointerX: 0.5, pointerY: 0.5, velocityX: 0.01, velocityY: 0, radius: 0.3, strength: 0.5, active: true, aspect: 1.5 }

  it('starts at "no push" (0.5) — an 8-bit field cleared to 0 would push everything', () => {
    const { ctx, clears } = context()
    expect(createLiquidField(ctx, 400, 200)).not.toBeNull()
    expect(clears[0]).toEqual([0.5, 0.5, 0, 1])
  })

  it('steps at the field size, then restores the full-canvas viewport (aura\'s corner-viewport bug)', () => {
    const { ctx, viewports } = context()
    const field = createLiquidField(ctx, 400, 200)!
    viewports.length = 0
    const before = field.texture
    field.step(state)
    expect(viewports.at(-1)).toEqual([0, 0, 1200, 800])
    expect(viewports[0]![2]).toBeLessThan(400) // a quarter-size field
    expect(field.texture).not.toBe(before) // ping-pong swapped
  })

  it('resizes only when the size really changes, and re-clears to neutral', () => {
    const { ctx, clears } = context()
    const field = createLiquidField(ctx, 400, 200)!
    clears.length = 0
    field.resize(400, 200)
    expect(clears).toHaveLength(0)
    field.resize(800, 400)
    expect(clears[0]).toEqual([0.5, 0.5, 0, 1])
    expect(() => field.destroy()).not.toThrow()
  })

  it.each([
    ['a shader that will not compile', { failShaderCompile: true }],
    ['a program that will not link', { failProgramLink: true }],
    ['a feedback buffer that cannot be allocated', { failCreateFramebuffer: true }],
  ] as const)('is null with %s', (_label, options) => {
    expect(createLiquidField(context(options).ctx, 400, 200)).toBeNull()
  })
})

describe("distort's per-frame wiring", () => {
  const originalGetContext = HTMLCanvasElement.prototype.getContext
  const originalRAF = globalThis.requestAnimationFrame
  let queued: FrameRequestCallback[]
  let intersection: FakeIntersection
  let handle: ComiceHandle | null
  let velocities: number[][]
  let now: number

  function useFakeGL(options: FakeGLOptions): void {
    ;(HTMLCanvasElement.prototype as any).getContext = function (type: string) {
      if (type !== 'webgl2') return originalGetContext.call(this, type)
      const gl = createFakeGL2(options)
      const uniform2f = gl.uniform2f.bind(gl)
      gl.uniform2f = (loc: WebGLUniformLocation | null, x: number, y: number) => {
        if ((loc as unknown as { __id: string } | null)?.__id === 'u_velocity') velocities.push([x, y])
        uniform2f(loc, x, y)
      }
      return gl
    }
  }
  function frames(n: number): void {
    for (let i = 0; i < n; i++) {
      now += 16
      const pending = queued
      queued = []
      pending.forEach((cb) => cb(now))
    }
  }
  function img(): HTMLImageElement {
    const el = document.createElement('img')
    Object.defineProperty(el, 'complete', { value: true })
    Object.defineProperty(el, 'naturalWidth', { value: 300 })
    Object.defineProperty(el, 'getBoundingClientRect', { value: () => ({ left: 0, top: 0, width: 300, height: 200, right: 300, bottom: 200, x: 0, y: 0, toJSON() {} }) })
    document.body.appendChild(el)
    return el
  }
  function driver(): Driver & { emit(s: DriverSignal): void } {
    let cb: ((s: DriverSignal) => void) | null = null
    return { name: 'fake', attach: (_t, on) => ((cb = on), () => {}), emit: (s) => cb?.(s) }
  }

  beforeEach(() => {
    queued = []
    velocities = []
    now = 0
    handle = null
    intersection = installFakeIntersectionObserver()
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      queued.push(cb)
      return queued.length
    }) as typeof requestAnimationFrame
    getSharedScheduler().stop()
  })
  afterEach(() => {
    handle?.destroy()
    getSharedScheduler().stop()
    globalThis.requestAnimationFrame = originalRAF
    HTMLCanvasElement.prototype.getContext = originalGetContext
    intersection.uninstall()
    document.body.innerHTML = ''
  })

  it('a moving pointer gives a velocity; a still one decays back to zero', () => {
    useFakeGL({})
    const d = driver()
    handle = (comice(img()) as ComiceHandle).use(distort({ effect: 'smear' })).driver(d)
    for (let x = 100; x <= 200; x += 20) {
      d.emit({ progress: 1, pointer: { x, y: 100 } })
      frames(1)
    }
    expect(Math.max(...velocities.map(([vx]) => vx))).toBeGreaterThan(0) // moving right
    frames(30) // pointer stops
    expect(velocities.at(-1)![0]).toBeCloseTo(0, 4)
  })

  it('liquid steps its field every visible frame, even after the pointer has stopped (it settles)', () => {
    // Counted, not "doesn't throw": the scheduler isolates a throwing frame
    // callback, so a broken step would never surface as a throw here.
    let steps = 0
    useFakeGL({})
    const withGL = HTMLCanvasElement.prototype.getContext
    ;(HTMLCanvasElement.prototype as any).getContext = function (type: string) {
      const gl = withGL.call(this, type) as WebGL2RenderingContext
      if (type === 'webgl2' && gl) {
        const bindFramebuffer = gl.bindFramebuffer.bind(gl)
        gl.bindFramebuffer = (t: number, fb: WebGLFramebuffer | null) => {
          if (fb) steps++
          bindFramebuffer(t, fb)
        }
      }
      return gl
    }
    const d = driver()
    handle = (comice(img()) as ComiceHandle).use(distort({ effect: 'liquid' })).driver(d)
    d.emit({ progress: 1, pointer: { x: 150, y: 100 } })
    frames(5) // includes one-off neutral clears on setup/resize, which also bind
    d.emit({ progress: 0, pointer: { x: 150, y: 100 } }) // pointer leaves
    const atLeave = steps
    frames(5)
    expect(steps - atLeave).toBe(5) // one step per frame, still running after the pointer left
  })

  it('liquid with no feedback buffer: error, and the media is shown', async () => {
    useFakeGL({ failCreateFramebuffer: true })
    const el = img()
    handle = (comice(el) as ComiceHandle).use(distort({ effect: 'liquid' }))
    const seen: ComiceEvent[] = []
    handle.on('error', (_s, e) => seen.push(e))
    await new Promise<void>((r) => queueMicrotask(r))
    expect(seen.map((e) => e.type)).toEqual(['error'])
    expect(el.style.visibility).toBe('')
  })
})
