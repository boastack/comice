/**
 * test/particles-sampler — packages/particles/src/sampler.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Sources are drawn at the STAGE's aspect (cover-fitted, never stretched)
 * and sampled to about `count` cells. They used to go into a fixed 128x128
 * square: `count` capped near 16k (the spec asks 120,000) and wide stages
 * squashed text.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { canvasSizeFor, coverRect, gridFor, rasterizeSource, resampleToCount, sampleGrid, type ParticleSample } from '../packages/particles/src/sampler.js'
import { installFake2DContext } from './fake-webgl2.js'

const style = { fontFamily: 'Inter', fontWeight: '800', color: 'rgb(242, 239, 232)' }

/** A canvas whose 2D context records what was drawn. */
function recordingCanvas(width: number, height: number, measured = 100) {
  const calls: { drawImage?: unknown[]; font?: string; fillStyle?: string; text?: string } = {}
  const ctx = {
    font: '',
    fillStyle: '',
    textAlign: '',
    textBaseline: '',
    clearRect() {},
    measureText: () => ({ width: measured }),
    drawImage: (...args: unknown[]) => (calls.drawImage = args),
    fillText(text: string) {
      calls.text = text
      calls.font = ctx.font
      calls.fillStyle = ctx.fillStyle
    },
  }
  return { canvas: { width, height, getContext: () => ctx } as unknown as HTMLCanvasElement, calls }
}

function media(width: number, height: number): HTMLImageElement {
  const img = document.createElement('img')
  Object.defineProperty(img, 'naturalWidth', { value: width })
  Object.defineProperty(img, 'naturalHeight', { value: height })
  return img
}

describe('gridFor', () => {
  it('about `count` cells, shaped like the stage', () => {
    const { columns, rows } = gridFor(120000, 16 / 9)
    expect(Math.abs(columns * rows - 120000) / 120000).toBeLessThan(0.01)
    expect(columns / rows).toBeCloseTo(16 / 9, 1)
    expect(gridFor(100, 1)).toEqual({ columns: 10, rows: 10 })
    expect(gridFor(0, 1)).toEqual({ columns: 1, rows: 1 })
  })
})

describe('coverRect', () => {
  it('crops the sides of a wider source and the top/bottom of a taller one, centred', () => {
    expect(coverRect(2000, 1000, 100, 100)).toEqual({ x: 500, y: 0, width: 1000, height: 1000 })
    expect(coverRect(600, 750, 800, 450)).toEqual({ x: 0, y: 206.25, width: 600, height: 337.5 })
  })
})

describe('canvasSizeFor', () => {
  it('keeps the stage aspect, at most 1024 on the long side', () => {
    expect(canvasSizeFor(800, 450)).toEqual({ width: 800, height: 450 })
    expect(canvasSizeFor(4000, 1000)).toEqual({ width: 1024, height: 256 })
    expect(canvasSizeFor(0, 0)).toEqual({ width: 1, height: 1 })
  })
})

describe('rasterizeSource', () => {
  it('cover-fits an image', () => {
    const { canvas, calls } = recordingCanvas(100, 100)
    expect(rasterizeSource(canvas, media(2000, 1000), style)).toBe(true)
    expect(calls.drawImage!.slice(1)).toEqual([500, 0, 1000, 1000, 0, 0, 100, 100])
  })

  it('reads a video by its video size', () => {
    const { canvas, calls } = recordingCanvas(100, 100)
    const video = document.createElement('video')
    Object.defineProperty(video, 'videoWidth', { value: 100 })
    Object.defineProperty(video, 'videoHeight', { value: 100 })
    expect(rasterizeSource(canvas, video, style)).toBe(true)
    expect(calls.drawImage!.slice(1, 5)).toEqual([0, 0, 100, 100])
  })

  it("fits text in the stage's own font and colour, or the source's", () => {
    const fits = recordingCanvas(800, 450, 100)
    rasterizeSource(fits.canvas, { text: 'COMICE' }, style)
    expect(fits.calls.font).toBe('800 315px Inter') // 70% of the height
    expect(fits.calls.fillStyle).toBe(style.color)

    const tooWide = recordingCanvas(800, 450, 1440) // twice the 720px allowed
    rasterizeSource(tooWide.canvas, { text: 'COMICE', font: 'Georgia', color: '#f00' }, style)
    expect(tooWide.calls.font).toBe('800 157px Georgia')
    expect(tooWide.calls.fillStyle).toBe('#f00')
  })

  it('false for media with no size yet, or no 2D context', () => {
    expect(rasterizeSource(recordingCanvas(10, 10).canvas, media(0, 0), style)).toBe(false)
    const noContext = { width: 10, height: 10, getContext: () => null } as unknown as HTMLCanvasElement
    expect(rasterizeSource(noContext, { text: 'x' }, style)).toBe(false)
  })
})

describe('sampleGrid', () => {
  let uninstall: () => void
  afterEach(() => uninstall())

  it('one particle per opaque cell, at cell centres — 120,000 is 120,000', () => {
    ;({ uninstall } = installFake2DContext({ imageDataAlpha: 255 }))
    const canvas = Object.assign(document.createElement('canvas'), { width: 800, height: 450 })
    const big = sampleGrid(canvas, 120000)!
    expect(big.count).toBe(big.columns * big.rows)
    expect(Math.abs(big.count - 120000) / 120000).toBeLessThan(0.01)

    const small = sampleGrid(Object.assign(document.createElement('canvas'), { width: 100, height: 100 }), 4)!
    expect(Array.from(small.positions)).toEqual([0.25, 0.25, 0.75, 0.25, 0.25, 0.75, 0.75, 0.75])
  })

  it('transparent cells get none', () => {
    ;({ uninstall } = installFake2DContext({ imageDataAlpha: 0 }))
    expect(sampleGrid(Object.assign(document.createElement('canvas'), { width: 10, height: 10 }), 100)!.count).toBe(0)
  })

  it('null without a 2D context', () => {
    ;({ uninstall } = installFake2DContext())
    uninstall()
    expect(sampleGrid(Object.assign(document.createElement('canvas'), { width: 10, height: 10 }), 100)).toBeNull()
    ;({ uninstall } = installFake2DContext())
  })
})

describe('resampleToCount', () => {
  const sample = (positions: number[]): ParticleSample => ({ positions: new Float32Array(positions), count: positions.length / 2, columns: 2, rows: 1 })

  it('the same sample when it already fits; truncated when longer', () => {
    const s = sample([0.1, 0.2, 0.3, 0.4])
    expect(resampleToCount(s, 2)).toBe(s)
    expect(Array.from(resampleToCount(s, 1).positions)).toEqual([0.1, 0.2].map(Math.fround))
  })

  it('pads by cycling through the sample (not piling onto the last point)', () => {
    const padded = resampleToCount(sample([0.1, 0.2, 0.3, 0.4]), 4)
    expect(Array.from(padded.positions)).toEqual([0.1, 0.2, 0.3, 0.4, 0.1, 0.2, 0.3, 0.4].map(Math.fround))
    expect(padded.columns).toBe(2)
  })

  it('an empty sample gathers at the centre', () => {
    expect(Array.from(resampleToCount(sample([]), 2).positions)).toEqual([0.5, 0.5, 0.5, 0.5])
  })
})

