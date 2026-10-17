import { describe, expect, it } from 'bun:test'
import { resolveShape, validateShape } from '../packages/morph/src/shape-input.js'
import { createRasterizedMask } from '../packages/core/src/gl/mask.js'
import { comice } from 'comice'
import { getSharedScheduler } from 'comice/scheduler'
import { morph } from '../packages/morph/src/index.js'
import { createFakeGL2, createFakeGLContext, installFake2DContext } from './fake-webgl2.js'

async function withFonts(load: (font: string, text: string) => Promise<unknown>, run: () => Promise<void>) {
  const original = Object.getOwnPropertyDescriptor(document, 'fonts')
  Object.defineProperty(document, 'fonts', { configurable: true, value: { load } })
  try { await run() }
  finally {
    if (original) Object.defineProperty(document, 'fonts', original)
    else delete (document as unknown as { fonts?: unknown }).fonts
  }
}

describe('morph text inputs', () => {
  it('rejects blank or non-string text and malformed font values before mounting', () => {
    for (const text of ['', '  ', undefined, 12]) {
      expect(() => validateShape({ type: 'text', text } as any)).toThrow(/non-empty text/)
    }
    for (const font of ['', ' ', 12]) {
      expect(() => validateShape({ type: 'text', text: 'Olawale Balo', font } as any)).toThrow(/CSS font string/)
    }
  })

  it('waits for the requested font and glyphs before resolving the mask', async () => {
    let finish!: () => void
    const waiting = new Promise<void>(resolve => { finish = resolve })
    const requests: string[][] = []
    await withFonts((font, text) => { requests.push([font, text]); return waiting }, async () => {
      let ready = false
      const shape = { type: 'text' as const, text: 'Olawale Balo', font: '700 160px Geist' }
      const pending = resolveShape(shape, new AbortController().signal).then(result => { ready = true; return result })
      await Promise.resolve()
      expect(requests).toEqual([['700 160px Geist', 'Olawale Balo']])
      expect(ready).toBe(false)
      finish()
      expect((await pending).mask).toBe(shape)
    })
  })

  it('cancels a pending font load without waiting for its network request', async () => {
    await withFonts(() => new Promise(() => {}), async () => {
      const controller = new AbortController()
      const pending = resolveShape({ type: 'text', text: 'Design Engineer', font: '700 160px Geist' }, controller.signal)
      controller.abort()
      await expect(pending).rejects.toThrow(/aborted/)
    })
  })

  it('reports font loading failures instead of baking a fallback silently', async () => {
    await withFonts(() => Promise.reject(new Error('Font download failed')), async () => {
      await expect(resolveShape({ type: 'text', text: 'Design Engineer', font: '700 160px Geist' }, new AbortController().signal)).rejects.toThrow('Font download failed')
    })
  })

  it('uses the target document font set for text inside another document', async () => {
    const other = document.implementation.createHTMLDocument()
    let loaded = false
    Object.defineProperty(other, 'fonts', { value: { load: async () => { loaded = true } } })
    await resolveShape({ type: 'text', text: 'Design Engineer', font: '700 160px Geist' }, new AbortController().signal, other)
    expect(loaded).toBe(true)
  })
})

describe('text mask geometry', () => {
  it('fits custom-font ink, including overhangs and descenders, inside the requested margin', () => {
    const raster = installFake2DContext()
    const original = HTMLCanvasElement.prototype.getContext
    const bounds: Array<{ left: number; right: number; top: number; bottom: number; scaleX: number; scaleY: number }> = []
    const metrics = { width: 1200, actualBoundingBoxLeft: 15, actualBoundingBoxRight: 1190, actualBoundingBoxAscent: 130, actualBoundingBoxDescent: 40 }
    HTMLCanvasElement.prototype.getContext = function(type: string, ...args: unknown[]) {
      const ctx = (original as any).call(this, type, ...args)
      if (type === '2d' && ctx) {
        let sx = 1, sy = 1, tx = 0, ty = 0
        ctx.measureText = () => metrics
        ctx.setTransform = (a: number, _b: number, _c: number, d: number, e: number, f: number) => { sx = a; sy = d; tx = e; ty = f }
        ctx.fillText = () => bounds.push({ left: tx - metrics.actualBoundingBoxLeft * sx, right: tx + metrics.actualBoundingBoxRight * sx, top: ty - metrics.actualBoundingBoxAscent * sy, bottom: ty + metrics.actualBoundingBoxDescent * sy, scaleX: sx, scaleY: sy })
      }
      return ctx
    } as typeof original
    try {
      for (const [width, height] of [[320, 320], [960, 540], [640, 80]]) {
        const mask = createRasterizedMask(createFakeGLContext(document.createElement('canvas')))
        mask.rasterize({ type: 'text', text: 'Design Engineer', font: 'italic 700 200px serif' }, width!, height!, { fill: .9, resolution: [width!, height!] })
        const ink = bounds.at(-1)!
        expect(ink.left).toBeGreaterThanOrEqual(width! * .05 - .001)
        expect(ink.right).toBeLessThanOrEqual(width! * .95 + .001)
        expect(ink.top).toBeGreaterThanOrEqual(height! * .05 - .001)
        expect(ink.bottom).toBeLessThanOrEqual(height! * .95 + .001)
        expect(ink.scaleX).toBe(ink.scaleY)
        expect((ink.left + ink.right) / 2).toBeCloseTo(width! / 2)
        expect((ink.top + ink.bottom) / 2).toBeCloseTo(height! / 2)
        mask.destroy()
      }
    } finally { HTMLCanvasElement.prototype.getContext = original; raster.uninstall() }
  })
})

describe('text transition rendering cost', () => {
  it('enables intermediate contour filtering only between two text masks', async () => {
    const raster = installFake2DContext()
    const original = HTMLCanvasElement.prototype.getContext
    const sources: string[] = []
    const gl = createFakeGL2()
    gl.shaderSource = (_shader, source) => { sources.push(source) }
    HTMLCanvasElement.prototype.getContext = function(type: string, ...args: unknown[]) {
      return type === 'webgl2' ? gl : (original as any).call(this, type, ...args)
    } as typeof original
    try {
      for (const bothText of [true, false]) {
        sources.length = 0
        const media = document.createElement('img')
        Object.defineProperties(media, { complete: { value: true }, naturalWidth: { value: 40 }, naturalHeight: { value: 20 } })
        Object.defineProperty(media, 'getBoundingClientRect', { value: () => ({ width: 40, height: 20 }) })
        document.body.append(media)
        const effect = morph({ from: { type: 'text', text: 'Olawale Balo' }, to: bothText ? { type: 'text', text: 'Design Engineer' } : 'circle(40%)' })
        const handle = comice(media).use(effect)
        try {
          for (let i = 0; i < 20; i++) await Promise.resolve()
          expect(sources.some(source => source.includes('filteredTextDistance'))).toBe(bothText)
        } finally { handle.destroy(); media.remove() }
      }
    } finally { getSharedScheduler().stop(); HTMLCanvasElement.prototype.getContext = original; raster.uninstall() }
  })
})
