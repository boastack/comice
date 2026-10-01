/**
 * test/render-visibility — spec §13, "off screen planes do zero work"
 * ─────────────────────────────────────────────────────────────────────────────
 * Every GL plugin's per-frame loop was gated only on `target.isConnected`,
 * so an effect scrolled out of view kept drawing every frame. Found on
 * harness/site/ in Chromium: particles alone, scrolled off-screen, held the
 * whole page at 4fps; removing it restored 61fps.
 *
 * Counts real draw calls on the fake GL context across hand-driven frames
 * while the element is scrolled out of view, into view, and out again.
 * Imports comice by PACKAGE name (built dist), matching every plugin test.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { comice, type ComiceHandle } from 'comice'
import { getSharedScheduler } from 'comice/scheduler'
import { aura } from '../packages/aura/src/index.js'
import { color } from '../packages/color/src/index.js'
import { dissolve } from '../packages/dissolve/src/index.js'
import { distort } from '../packages/distort/src/index.js'
import { morph } from '../packages/morph/src/index.js'
import { mosaic } from '../packages/mosaic/src/index.js'
import { createFakeGL2 } from './fake-webgl2.js'
import { installFakeIntersectionObserver, type FakeIntersection } from './fake-intersection.js'

function readyImage(): HTMLImageElement {
  const img = document.createElement('img')
  Object.defineProperty(img, 'complete', { value: true, configurable: true })
  Object.defineProperty(img, 'naturalWidth', { value: 800, configurable: true })
  Object.defineProperty(img, 'naturalHeight', { value: 600, configurable: true })
  return img
}

const originalGetContext = HTMLCanvasElement.prototype.getContext
const originalRAF = globalThis.requestAnimationFrame
let draws = 0
let queued: FrameRequestCallback[] = []
let now = 0
let intersection: FakeIntersection
let wrap: HTMLElement
let handle: ComiceHandle | null

function frames(n: number): void {
  for (let i = 0; i < n; i++) {
    now += 16
    const pending = queued
    queued = []
    pending.forEach((cb) => cb(now))
  }
}

beforeEach(() => {
  draws = 0
  queued = []
  ;(HTMLCanvasElement.prototype as any).getContext = function (type: string) {
    if (type !== 'webgl2') return originalGetContext.call(this, type)
    const gl = createFakeGL2()
    const drawArrays = gl.drawArrays.bind(gl)
    gl.drawArrays = (...args: Parameters<WebGL2RenderingContext['drawArrays']>) => {
      draws++
      drawArrays(...args)
    }
    return gl
  }
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    queued.push(cb)
    return queued.length
  }) as typeof requestAnimationFrame
  intersection = installFakeIntersectionObserver({ visible: false }) // starts scrolled out of view
  wrap = document.createElement('div')
  document.body.appendChild(wrap)
  handle = null
})

afterEach(() => {
  handle?.destroy()
  getSharedScheduler().stop()
  HTMLCanvasElement.prototype.getContext = originalGetContext
  globalThis.requestAnimationFrame = originalRAF
  intersection.uninstall()
  wrap.remove()
})

// ascii and particles carry the identical gate but are not counted here:
// both need a 2D canvas (ascii's glyph atlas, particles' source sampling)
// that happy-dom does not provide, so neither ever reaches a draw call in
// this environment, visible or not.
const MEDIA = {
  distort: () => distort({ effect: 'bulge' }),
  color: () => color({ effects: ['grain'] }),
  mosaic: () => mosaic({ fill: 'pixelate' }),
  morph: () => morph({ operation: 'merge' }),
  aura: () => aura({ glow: false, sampleIntervalMs: 0 }),
} as const

describe('GL plugins draw only while on screen', () => {
  it.each(Object.keys(MEDIA) as Array<keyof typeof MEDIA>)('%s', (name) => {
    const img = readyImage()
    wrap.appendChild(img)
    handle = comice(img) as ComiceHandle
    handle.use(MEDIA[name]())

    draws = 0 // ignore the one direct render at setup
    frames(10)
    expect(draws).toBe(0) // scrolled out of view: zero work

    intersection.setVisible(true)
    frames(10)
    expect(draws).toBeGreaterThan(0) // scrolled into view: drawing again

    intersection.setVisible(false)
    const atLeave = draws
    frames(10)
    expect(draws).toBe(atLeave) // and stops again
  })

  it('dissolve (a container target)', () => {
    const stage = document.createElement('div')
    wrap.appendChild(stage)
    handle = comice(stage) as ComiceHandle
    handle.use(dissolve({ from: readyImage(), to: readyImage() }))

    draws = 0
    frames(10)
    expect(draws).toBe(0)

    intersection.setVisible(true)
    frames(10)
    expect(draws).toBeGreaterThan(0)
  })
})
