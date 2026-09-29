/**
 * test/gl-shared-canvas.test — how GL plugins share one element's canvas
 * ─────────────────────────────────────────────────────────────────────────────
 * Cross-plugin regressions for bugs found running many plugins together on
 * harness/site/ in Chromium. Each plugin's own test file only ever mounted
 * that one plugin, so none of these interactions were covered:
 *
 *  - tearing down one plugin blanked another sharing the element's canvas
 *    (aura's teardown removed distort's canvas; a second shader restored
 *    the first one's `hidden` over the media);
 *  - two shader plugins on one element silently overwrote each other;
 *  - container plugins (dissolve, particles) covered their whole section.
 *
 * Imports comice by PACKAGE name (built dist), matching every plugin test.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { comice, type ComiceHandle } from 'comice'
import { getSharedScheduler } from 'comice/scheduler'
import { ascii } from '../packages/ascii/src/index.js'
import { aura } from '../packages/aura/src/index.js'
import { color } from '../packages/color/src/index.js'
import { dissolve } from '../packages/dissolve/src/index.js'
import { distort } from '../packages/distort/src/index.js'
import { morph } from '../packages/morph/src/index.js'
import { mosaic } from '../packages/mosaic/src/index.js'
import { particles } from '../packages/particles/src/index.js'
import { createFakeGL2, type FakeGLOptions } from './fake-webgl2.js'

function readyImage(): HTMLImageElement {
  const img = document.createElement('img')
  Object.defineProperty(img, 'complete', { value: true, configurable: true })
  Object.defineProperty(img, 'naturalWidth', { value: 800, configurable: true })
  Object.defineProperty(img, 'naturalHeight', { value: 600, configurable: true })
  return img
}

const originalGetContext = HTMLCanvasElement.prototype.getContext
function useFakeGL(options: FakeGLOptions = {}): void {
  ;(HTMLCanvasElement.prototype as any).getContext = function (type: string) {
    if (type === 'webgl2') return createFakeGL2(options)
    return originalGetContext.call(this, type)
  }
}

let wrap: HTMLElement
let handles: ComiceHandle[] = []

beforeEach(() => {
  wrap = document.createElement('div')
  document.body.appendChild(wrap)
  handles = []
})

afterEach(() => {
  handles.forEach((h) => h.destroy())
  HTMLCanvasElement.prototype.getContext = originalGetContext
  getSharedScheduler().stop()
  wrap.remove()
})

function mountImage(): HTMLImageElement {
  const img = readyImage()
  wrap.appendChild(img)
  return img
}

function track(handle: ComiceHandle): ComiceHandle {
  handles.push(handle)
  return handle
}

const MEDIA_PLUGINS = {
  distort: () => distort({ effect: 'bulge' }),
  color: () => color({ effects: ['grain'] }),
  mosaic: () => mosaic({ fill: 'pixelate' }),
  ascii: () => ascii(),
  morph: () => morph({ operation: 'merge' }),
} as const

describe('a failed shader compile shows the original media, not a hidden image behind an empty canvas', () => {
  it.each(Object.keys(MEDIA_PLUGINS) as Array<keyof typeof MEDIA_PLUGINS>)('%s', (name) => {
    useFakeGL({ failShaderCompile: true })
    const img = mountImage()
    track(comice(img) as ComiceHandle).use(MEDIA_PLUGINS[name]())

    expect(img.style.visibility).toBe('')
    expect(wrap.querySelector('canvas')).toBeNull()
  })
})

describe('one GL effect per element', () => {
  it('a second shader plugin on the same element throws, naming both — instead of silently replacing the first', () => {
    useFakeGL()
    const img = mountImage()
    track(comice(img) as ComiceHandle).use(distort())

    expect(() => track(comice(img) as ComiceHandle).use(color({ effects: ['duotone'] }))).toThrow(/color\(\).*distort\(\)/)
    // The first effect is untouched by the refused one.
    expect(img.style.visibility).toBe('hidden')
    expect(wrap.querySelectorAll('canvas').length).toBe(1)
  })

  it('the same rule applies to two plugins on ONE instance', () => {
    useFakeGL()
    const img = mountImage()
    const handle = track(comice(img) as ComiceHandle).use(distort())
    expect(() => handle.use(color({ effects: ['duotone'] }))).toThrow(/color\(\).*distort\(\)/)
  })

  it('after the first effect is destroyed, the element accepts a new one (hover-swap: mosaic -> ascii)', () => {
    useFakeGL()
    const img = mountImage()
    const first = comice(img) as ComiceHandle
    first.use(mosaic({ fill: 'dither' }))
    first.destroy()

    track(comice(img) as ComiceHandle).use(ascii())
    expect(img.style.visibility).toBe('hidden')
    expect(wrap.querySelectorAll('canvas').length).toBe(1)
  })

  it('destroying the effect restores the media exactly (no stale `hidden`)', () => {
    useFakeGL()
    const img = mountImage()
    const handle = comice(img) as ComiceHandle
    handle.use(distort())
    handle.destroy()

    expect(img.style.visibility).toBe('')
    expect(wrap.querySelector('canvas')).toBeNull()
  })
})

describe('aura shares the element with a drawing plugin', () => {
  it("destroying aura leaves the other plugin's canvas in place (it used to remove it, blanking the hero)", () => {
    useFakeGL()
    const img = mountImage()
    track(comice(img) as ComiceHandle).use(distort())
    const auraHandle = comice(img) as ComiceHandle
    auraHandle.use(aura({ glow: false }))

    auraHandle.destroy()

    expect(wrap.querySelectorAll('canvas').length).toBe(1)
    expect(img.style.visibility).toBe('hidden') // still distort's
  })
})

describe('container plugins (dissolve, particles)', () => {
  function stageInSection(): { section: HTMLElement; heading: HTMLElement; stage: HTMLDivElement } {
    const section = document.createElement('section')
    const heading = document.createElement('h2')
    const stage = document.createElement('div')
    section.append(heading, stage)
    wrap.appendChild(section)
    Object.defineProperty(stage, 'offsetTop', { value: 160, configurable: true })
    Object.defineProperty(stage, 'offsetHeight', { value: 420, configurable: true })
    return { section, heading, stage }
  }

  it("dissolve's canvas covers only its stage, not the section's heading", () => {
    useFakeGL()
    const { stage } = stageInSection()
    track(comice(stage) as ComiceHandle).use(dissolve({ from: readyImage(), to: readyImage() }))

    const canvas = stage.nextElementSibling as HTMLCanvasElement
    expect(canvas.tagName).toBe('CANVAS')
    expect(canvas.style.top).toBe('160px')
    expect(canvas.style.height).toBe('420px')
    expect(stage.style.visibility).toBe('') // a container is never hidden
  })

  it("particles' canvas covers only its target", () => {
    useFakeGL()
    const { stage } = stageInSection()
    track(comice(stage) as ComiceHandle).use(particles({ from: readyImage() }))

    const canvas = stage.nextElementSibling as HTMLCanvasElement
    expect(canvas.style.top).toBe('160px')
    expect(canvas.style.height).toBe('420px')
  })

  it.each([
    ['dissolve', () => dissolve({ from: readyImage(), to: readyImage() })],
    ['particles', () => particles({ from: readyImage() })],
  ] as const)('%s on an SVG target mounts nothing (a canvas cannot render inside <svg>) and does not throw', (_name, make) => {
    useFakeGL()
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g')
    svg.appendChild(group)
    wrap.appendChild(svg)

    expect(() => track(comice(group) as ComiceHandle).use(make())).not.toThrow()
    expect(wrap.querySelector('canvas')).toBeNull()
  })
})
