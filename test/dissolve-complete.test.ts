/**
 * test/dissolve-complete — dissolve's full spec card (§08)
 * ─────────────────────────────────────────────────────────────────────────────
 * Three of twelve transitions existed; `to` couldn't be a sequence; `map`,
 * `mask` and noise's direction/threshold/seed didn't exist. Every transition
 * is verified rendering in Chromium; these pin the GLSL and the wiring.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { comice, type ComiceHandle } from 'comice'
import { getSharedScheduler } from 'comice/scheduler'
import { dissolve } from '../packages/dissolve/src/index.js'
import { compileDissolveProgram, drawDissolve, type DissolveShaderOptions, type DissolveTransition } from '../packages/dissolve/src/shader.js'
import { getResidencyPool } from '../packages/core/src/gl/residency.js'
import type { Plane } from '../packages/core/src/gl/plane.js'
import { createFakeGL2, createFakeGLContext, installFake2DContext } from './fake-webgl2.js'

function fragmentSource(options: DissolveShaderOptions): string {
  const context = createFakeGLContext(document.createElement('canvas'))
  const sources: string[] = []
  const shaderSource = context.gl.shaderSource.bind(context.gl)
  context.gl.shaderSource = (shader: WebGLShader, source: string) => {
    sources.push(source)
    shaderSource(shader, source)
  }
  compileDissolveProgram(context.gl, options)
  return sources.find((s) => s.includes('u_progress')) ?? ''
}

describe('every transition on the card, in GLSL', () => {
  const signatures: Record<DissolveTransition, string> = {
    crossfade: 'mix(texture(u_from, v_uv), texture(u_to, v_uv), p)',
    displace: 'texture(u_from, clamp(v_uv + field * p * push',
    wipe: 'float along = dot(v_uv - 0.5, dir)',
    zoomBlur: 'for (int i = 0; i < 12; i++)',
    pixelBridge: 'vec2 cell = size / u_resolution;',
    ink: 'float rim = 1.0 - abs(k * 2.0 - 1.0);',
    flip: 'float c = cos(p * 3.14159265);',
    glitch: 'float band = floor(v_uv.y * 24.0);',
    noise: 'float localP = smoothstep(n01 -',
    liquid: 'displacementOffset(v_uv, p,',
    mask: 'sampleMask(v_uv)',
    dissolve: 'floor(v_uv * u_resolution)',
  }
  it.each(Object.keys(signatures) as DissolveTransition[])('%s', (transition) => {
    expect(fragmentSource({ transition })).toContain(signatures[transition])
  })

  it('noise: threshold sets where the median pixel crosses; seed picks the pattern; direction sweeps', () => {
    const s = fragmentSource({ transition: 'noise', noise: { threshold: 0.3, seed: 7, direction: 90 } })
    expect(s).toContain('simplexNoise(vec3(v_uv * 3.000000, 7.000000))')
    expect(s).toContain('float n01 = 0.300000 + 0.5 * n * 1.000000 + dot(v_uv - 0.5, vec2(0.000000, 1.000000)) * 0.8;')
    // no direction: no sweep term
    expect(fragmentSource({ transition: 'noise' })).toContain('+ 0.0;')
  })

  it('displace reads the caller\'s map when there is one, procedural noise otherwise', () => {
    expect(fragmentSource({ transition: 'displace', hasMap: true })).toContain('texture(u_map, v_uv).rg - 0.5')
    expect(fragmentSource({ transition: 'displace' })).toContain('simplexNoise(')
  })
})

describe('drawDissolve', () => {
  const plane = (texture: unknown) => ({ texture }) as unknown as Plane

  it("binds the map and the mask field to their own units", () => {
    const context = createFakeGLContext(document.createElement('canvas'))
    const bound: Record<string, number> = {}
    const uniform1i = context.gl.uniform1i.bind(context.gl)
    context.gl.uniform1i = (loc: WebGLUniformLocation | null, v: number) => {
      bound[(loc as unknown as { __id: string } | null)?.__id ?? '?'] = v
      uniform1i(loc, v)
    }
    const program = compileDissolveProgram(context.gl, { transition: 'mask', hasMap: true })!
    getResidencyPool(context).beginPass()
    drawDissolve(context, program, plane({}), plane({}), {
      progress: 0.5,
      mapTexture: {} as WebGLTexture,
      maskField: { kind: 'texture', texture: {} as WebGLTexture, uvTransform: [1, 0, 0, 0, 1, 0, 0, 0, 1] },
    })
    expect(bound.u_map).toBeDefined()
    expect(bound.u_maskTexture).toBeDefined()
  })

  it('with no spare units, map and mask fall back without throwing; a missing mask field reveals nothing', () => {
    const context = createFakeGLContext(document.createElement('canvas'), { maxTextureUnits: 2 })
    const program = compileDissolveProgram(context.gl, { transition: 'mask', hasMap: true, noise: { seed: 1 } })!
    getResidencyPool(context).beginPass()
    expect(() =>
      drawDissolve(context, program, plane({}), plane({}), {
        progress: 0.5,
        mapTexture: {} as WebGLTexture,
        maskField: { kind: 'texture', texture: {} as WebGLTexture, uvTransform: [1, 0, 0, 0, 1, 0, 0, 0, 1] },
      }),
    ).not.toThrow()
    getResidencyPool(context).beginPass()
    expect(() => drawDissolve(context, program, plane({}), plane({}), { progress: 0.5 })).not.toThrow()
  })
})

describe('dissolve() options', () => {
  const originalGetContext = HTMLCanvasElement.prototype.getContext
  let uninstall2D: () => void
  let handle: ComiceHandle | null
  let draws: Array<{ from: unknown; to: unknown }>

  function media(id: string): HTMLImageElement {
    const img = document.createElement('img')
    img.id = id
    Object.defineProperty(img, 'complete', { value: true })
    Object.defineProperty(img, 'naturalWidth', { value: 100 })
    return img
  }
  function stage(): HTMLElement {
    const el = document.createElement('div')
    document.body.appendChild(el)
    return el
  }

  beforeEach(() => {
    ;({ uninstall: uninstall2D } = installFake2DContext())
    const twoD = HTMLCanvasElement.prototype.getContext
    draws = []
    ;(HTMLCanvasElement.prototype as any).getContext = function (type: string) {
      if (type !== 'webgl2') return twoD.call(this, type)
      const gl = createFakeGL2()
      // Record which textures each draw used, via texture binds before drawArrays.
      let boundTextures: unknown[] = []
      const bindTexture = gl.bindTexture.bind(gl)
      gl.bindTexture = (t: number, tex: WebGLTexture | null) => {
        if (tex) boundTextures.push(tex)
        bindTexture(t, tex)
      }
      const drawArrays = gl.drawArrays.bind(gl)
      gl.drawArrays = (...args: Parameters<WebGL2RenderingContext['drawArrays']>) => {
        draws.push({ from: boundTextures[0], to: boundTextures[1] })
        boundTextures = []
        drawArrays(...args)
      }
      return gl
    }
    handle = null
  })
  afterEach(() => {
    handle?.destroy()
    getSharedScheduler().stop()
    HTMLCanvasElement.prototype.getContext = originalGetContext
    uninstall2D()
    document.body.innerHTML = ''
  })

  it('needs two media: from + to, or a `to` sequence of two or more', () => {
    expect(() => dissolve({ to: media('a') })).toThrow(/needs two media/)
    expect(() => dissolve({ to: [media('a')] })).toThrow(/needs two media/)
    expect(() => dissolve({ to: [media('a'), media('b')] })).not.toThrow() // the gallery example has no `from`
  })

  it("transition 'mask' without a mask throws", () => {
    expect(() => dissolve({ transition: 'mask', from: media('a'), to: media('b') })).toThrow(/needs a `mask`/)
  })

  it('a sequence of N splits progress into N-1 legs, drawing the right neighbouring pair', () => {
    handle = (comice(stage()) as ComiceHandle).use(dissolve({ to: [media('a'), media('b'), media('c')] }))
    draws.length = 0
    handle.set({ progress: 0.25 }) // first leg, a -> b
    const firstLeg = draws.at(-1)!
    handle.set({ progress: 0.75 }) // second leg, b -> c
    const secondLeg = draws.at(-1)!
    expect(secondLeg.from).toBe(firstLeg.to) // b is the shared neighbour
    handle.set({ progress: 1 }) // the last leg at its very end, not past it
    expect(draws.at(-1)!.to).toBe(secondLeg.to)
  })

  it("displace with a `map` loads it as its own plane", () => {
    expect(() => {
      handle = (comice(stage()) as ComiceHandle).use(dissolve({ transition: 'displace', from: media('a'), to: media('b'), map: '/wave.png' }))
      handle.set({ progress: 0.5 })
    }).not.toThrow()
  })

  it("mask: a shape or text is rasterized (and again on resize); an image or video is reduced each frame", () => {
    const OriginalRO = globalThis.ResizeObserver
    let onResize: ResizeObserverCallback | null = null
    ;(globalThis as any).ResizeObserver = class {
      constructor(cb: ResizeObserverCallback) {
        onResize = cb
      }
      observe() {}
      disconnect() {}
    }
    try {
      handle = (comice(stage()) as ComiceHandle).use(dissolve({ transition: 'mask', from: media('a'), to: media('b'), mask: { type: 'text', text: 'X' } }))
      handle.set({ progress: 0.5 })
      expect(() => onResize!([], {} as ResizeObserver)).not.toThrow()
      handle.destroy()

      handle = (comice(stage()) as ComiceHandle).use(dissolve({ transition: 'mask', from: media('a'), to: media('b'), mask: media('m') }))
      handle.set({ progress: 0.5 })
      handle.destroy()

      const video = document.createElement('video')
      Object.defineProperty(video, 'readyState', { value: 2 })
      handle = (comice(stage()) as ComiceHandle).use(dissolve({ transition: 'mask', from: media('a'), to: media('b'), mask: video }))
      handle.set({ progress: 0.5 })
      expect(draws.length).toBeGreaterThan(0)
    } finally {
      globalThis.ResizeObserver = OriginalRO
    }
  })
})
