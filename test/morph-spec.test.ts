/**
 * test/morph-spec — spec §08's morph example, line by line:
 *
 *   morph({ operation: 'mask', into: 'svg', path: 'M12 2L2 7…',
 *           liquid: 0.7, thread: { sag: 6, dissolve: 4 } })
 *
 * `into`/`path` weren't options; a path was drawn at its own coordinates
 * (a 24px icon in the corner); thread was ignored for mask and its units
 * made `sag: 6` droop 1.5x the strand's length; and every morph showed the
 * whole frame, because its output wasn't premultiplied. All verified in
 * Chromium with screenshots; these pin the source.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { comice } from 'comice'
import { fitTransform, pathBounds } from '../packages/core/src/gl/mask.js'
import { createRasterizedMask } from '../packages/core/src/gl/mask.js'
import { morph } from '../packages/morph/src/index.js'
import { compileMorphProgram, type MorphShaderOptions } from '../packages/morph/src/shader.js'
import { SD_THREAD_GLSL } from '../packages/morph/src/thread.js'
import { createFakeGLContext, installFake2DContext } from './fake-webgl2.js'

function fragmentSource(options: MorphShaderOptions): string {
  const context = createFakeGLContext(document.createElement('canvas'))
  const sources: string[] = []
  const shaderSource = context.gl.shaderSource.bind(context.gl)
  context.gl.shaderSource = (shader: WebGLShader, source: string) => {
    sources.push(source)
    shaderSource(shader, source)
  }
  compileMorphProgram(context.gl, options)
  return sources.find((s) => s.includes('u_progress')) ?? ''
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe("into: 'svg', path — the spec's own option shape", () => {
  it('is accepted, and so is into: text', () => {
    expect(() => morph({ operation: 'mask', into: 'svg', path: 'M12 2L2 7l10 5 10-5-10-5z', liquid: 0.7, thread: { sag: 6, dissolve: 4 } })).not.toThrow()
    expect(() => morph({ operation: 'mask', into: 'text', text: 'ACME' })).not.toThrow()
  })

  it('missing pieces fail clearly at construction', () => {
    expect(() => morph({ operation: 'mask', into: 'svg' })).toThrow(/needs a `path`/)
    expect(() => morph({ operation: 'mask', into: 'text' })).toThrow(/needs a `text`/)
    expect(() => morph({ operation: 'mask' })).toThrow(/into: 'svg', path/)
  })

  it('rasterizes the path fitted to the media, by its viewBox', () => {
    const { uninstall } = installFake2DContext()
    const transforms: number[][] = []
    const getContext = HTMLCanvasElement.prototype.getContext
    ;(HTMLCanvasElement.prototype as any).getContext = function (type: string) {
      const ctx = getContext.call(this, type) as any
      if (type === '2d' && ctx) ctx.setTransform = (...args: number[]) => transforms.push(args)
      return ctx
    }
    try {
      const context = createFakeGLContext(document.createElement('canvas'))
      document.body.appendChild(context.canvas)
      createRasterizedMask(context).rasterize({ type: 'shape', path: 'M12 2L2 7l10 5 10-5-10-5z', viewBox: [0, 0, 24, 24] }, 640, 400)
      // 24x24 into 640x400 at 80%: scale min(512/24, 320/24) = 13.33, centred.
      expect(transforms[0]![0]).toBeCloseTo(13.333, 2)
      expect(transforms[0]!.slice(4)).toEqual([160, 40])
      expect(transforms.at(-1)).toEqual([1, 0, 0, 1, 0, 0]) // reset after
    } finally {
      HTMLCanvasElement.prototype.getContext = getContext
      uninstall()
    }
  })
})

describe('core mask fitting', () => {
  it('fitTransform centres and contains the bounds at 80%', () => {
    expect(fitTransform([0, 0, 24, 24], 640, 400)).toEqual([320 / 24, 320 - 12 * (320 / 24), 200 - 12 * (320 / 24)])
    expect(fitTransform([10, 10, 100, 50], 100, 100)).toEqual([0.8, 50 - 60 * 0.8, 50 - 35 * 0.8])
  })

  it("pathBounds measures with the browser's SVG engine, and gives null where it can't", () => {
    // The prototype the created <path> actually reads getBBox from.
    let proto = Object.getPrototypeOf(document.createElementNS('http://www.w3.org/2000/svg', 'path'))
    while (proto && !Object.prototype.hasOwnProperty.call(proto, 'getBBox') && Object.getPrototypeOf(proto) !== Object.prototype) proto = Object.getPrototypeOf(proto)
    const original = Object.getOwnPropertyDescriptor(proto, 'getBBox')
    proto.getBBox = () => ({ x: 2, y: 2, width: 20, height: 10 })
    expect(pathBounds(document, 'M2 2h20v10z')).toEqual([2, 2, 20, 10])
    proto.getBBox = () => ({ x: 0, y: 0, width: 0, height: 0 })
    expect(pathBounds(document, '')).toBeNull()
    proto.getBBox = () => {
      throw new Error('not rendered')
    }
    expect(pathBounds(document, 'M0 0')).toBeNull()
    proto.getBBox = undefined // no SVG engine at all
    expect(pathBounds(document, 'M0 0')).toBeNull()
    if (original) Object.defineProperty(proto, 'getBBox', original)
    else delete proto.getBBox
    expect(document.querySelectorAll('svg')).toHaveLength(0) // cleaned up every time
  })

  it('text is centred and shrunk to fit a narrow box', () => {
    const { uninstall, callLog } = installFake2DContext() // measureText: 10px a character
    let align = ''
    let at: number[] = []
    let font = ''
    const getContext = HTMLCanvasElement.prototype.getContext
    ;(HTMLCanvasElement.prototype as any).getContext = function (type: string) {
      const ctx = getContext.call(this, type) as any
      if (type === '2d' && ctx) {
        ctx.fillText = (_t: string, x: number, y: number) => {
          align = ctx.textAlign
          at = [x, y]
          font = ctx.font
        }
      }
      return ctx
    }
    try {
      const context = createFakeGLContext(document.createElement('canvas'))
      document.body.appendChild(context.canvas)
      createRasterizedMask(context).rasterize({ type: 'text', text: 'A VERY LONG NAME' }, 100, 100) // 160px measured at 60px
      expect(align).toBe('center')
      expect(at).toEqual([50, 50])
      expect(font).toBe('30px sans-serif') // 60 * 80 / 160
      createRasterizedMask(context).rasterize({ type: 'text', text: 'X', font: '12px serif' }, 100, 100)
      expect(font).toBe('12px serif') // a given font is used as is
      void callLog
    } finally {
      HTMLCanvasElement.prototype.getContext = getContext
      uninstall()
    }
  })
})

describe('thread', () => {
  it('is in px (one CSS pixel = 1 / u_resolution.y in st): sag and dissolve no longer scale with the strand', () => {
    const source = fragmentSource({ operation: 'merge', layout: 'shelf', thread: { width: 4, sag: 6, dissolve: 4 } })
    expect(source).toContain('float px = 1.0 / u_resolution.y;')
    expect(source).toContain('4.000000 * px,\n    0.400000,\n    6.000000 * px,\n    4.000000 * px,')
    expect(SD_THREAD_GLSL).toContain('float sagAmount = sag * separation * 4.0 * t * (1.0 - t);')
    expect(SD_THREAD_GLSL).toContain('float tearAmount = dissolve * separation;')
  })

  it("defaults: width 8px, pinch 0.4, sag 10px, dissolve 3px", () => {
    expect(fragmentSource({ operation: 'merge', layout: 'shelf', thread: {} })).toContain('8.000000 * px,\n    0.400000,\n    10.000000 * px,\n    3.000000 * px,')
  })

  it('on mask: four corner drops on strands, each snapping at its own moment', () => {
    const source = fragmentSource({ operation: 'mask', thread: { sag: 6, dissolve: 4 } })
    expect(source).toContain('float sminMask(')
    for (const snap of ['0.50', '0.58', '0.54', '0.62']) expect(source).toContain(`if (p < ${snap}) {`)
    expect(source.match(/sdThread\(st, drop, vec2\(0\.0\)/g)).toHaveLength(4)
    const plain = fragmentSource({ operation: 'mask' })
    expect(plain).not.toContain('sdThread')
    expect(plain).not.toContain('sminMask')
  })
})

describe('output', () => {
  it('is premultiplied (the canvas is): outside the shape is transparent, not the whole frame', () => {
    const source = fragmentSource({ operation: 'merge', layout: 'shelf' })
    expect(source).toContain('outColor = vec4(finalColor * outAlpha, outAlpha);')
  })

  it('runs end to end on an image', () => {
    const img = document.createElement('img')
    document.body.appendChild(img)
    expect(() => comice(img).use(morph({ operation: 'mask', into: 'svg', path: 'M12 2L2 7l10 5 10-5-10-5z', thread: { sag: 6, dissolve: 4 } })).destroy()).not.toThrow()
  })
})
