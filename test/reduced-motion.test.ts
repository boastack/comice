/**
 * test/reduced-motion — spec rule 04, "reduced motion ... the media still shows"
 * ─────────────────────────────────────────────────────────────────────────────
 * Nothing in Comice checked `prefers-reduced-motion` at all. The decision:
 * plugins that MOVE jump straight to their end state with no animation in
 * between; anything that moves on its own clock stops; plugins that only
 * change how media looks keep working.
 *
 * matchMedia is faked with a live, flippable MediaQueryList — the same
 * object a real browser returns, whose `.matches` follows the OS setting.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { comice, type ComiceHandle } from 'comice'
import { click as packageClick } from 'comice/drivers'
import { getSharedScheduler as getPackageScheduler } from 'comice/scheduler'
import { prefersReducedMotion, snapForReducedMotion } from '../packages/core/src/motion.js'
import { createTween } from '../packages/core/src/drivers/tween.js'
import { drag } from '../packages/core/src/drivers/drag.js'
import { getSharedScheduler } from '../packages/core/src/scheduler.js'
import { distort } from '../packages/distort/src/index.js'
import { type } from '../packages/type/src/index.js'
import { createFakeGL2 } from './fake-webgl2.js'

const originalMatchMedia = globalThis.matchMedia
const query = { matches: false, media: '(prefers-reduced-motion: reduce)' }

function setReducedMotion(on: boolean): void {
  query.matches = on
}

beforeEach(() => {
  query.matches = false
  ;(globalThis as any).matchMedia = (media: string) => (media === query.media ? query : { matches: false, media })
})

afterEach(() => {
  globalThis.matchMedia = originalMatchMedia
  getSharedScheduler().stop()
  getPackageScheduler().stop()
})

describe('prefersReducedMotion / snapForReducedMotion', () => {
  it('follows the OS setting live, with the page open', () => {
    expect(prefersReducedMotion()).toBe(false)
    setReducedMotion(true)
    expect(prefersReducedMotion()).toBe(true)
    setReducedMotion(false)
    expect(prefersReducedMotion()).toBe(false)
  })

  it('is false where matchMedia does not exist (server rendering, old engines)', () => {
    ;(globalThis as any).matchMedia = undefined
    expect(prefersReducedMotion()).toBe(false)
  })

  it('passes progress through normally; under reduced motion snaps to the closer end state', () => {
    expect(snapForReducedMotion(0.3)).toBe(0.3)
    setReducedMotion(true)
    expect(snapForReducedMotion(0.3)).toBe(0)
    expect(snapForReducedMotion(0.5)).toBe(1)
    expect(snapForReducedMotion(0.9)).toBe(1)
  })
})

describe('drivers under reduced motion', () => {
  it('click/hover animation arrives instantly — no in-between values', () => {
    setReducedMotion(true)
    const values: number[] = []
    createTween((s) => values.push(s.progress), 400).to(1)
    expect(values).toEqual([1, 1]) // synchronous arrival (plus the settle repeat)
  })

  it('a drag release does not coast on after the pointer stops', () => {
    setReducedMotion(true)
    const queued: FrameRequestCallback[] = []
    const originalRAF = globalThis.requestAnimationFrame
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      queued.push(cb)
      return queued.length
    }) as typeof requestAnimationFrame
    const target = document.createElement('div')
    Object.defineProperty(target, 'getBoundingClientRect', {
      value: () => ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0, toJSON() {} }),
      configurable: true,
    })
    document.body.appendChild(target)
    try {
      const signals: number[] = []
      const detach = drag().attach(target, (s) => signals.push(s.progress))
      const ev = (type: string, clientX: number, timeStamp: number) => {
        const e = new PointerEvent(type, { clientX, clientY: 50, pointerId: 1, bubbles: true })
        Object.defineProperty(e, 'timeStamp', { value: timeStamp })
        target.dispatchEvent(e)
      }
      ev('pointerdown', 0, 0)
      ev('pointermove', 60, 16) // a fast flick
      ev('pointerup', 60, 32)
      const atRelease = signals.length
      queued.splice(0).forEach((cb) => cb(48))
      expect(signals.length).toBe(atRelease) // no inertia frames
      detach()
    } finally {
      globalThis.requestAnimationFrame = originalRAF
      target.remove()
    }
  })
})

describe('plugins under reduced motion', () => {
  let el: HTMLElement
  let handle: ComiceHandle | null

  beforeEach(() => {
    handle = null
  })
  afterEach(() => {
    handle?.destroy()
    el?.remove()
  })

  it('type melt jumps to its end state instead of blurring through the middle', () => {
    el = document.createElement('h2')
    document.body.appendChild(el)
    handle = comice(el) as ComiceHandle
    handle.use(type({ mode: 'melt' }))

    handle.setProgress(0.5) // melt's blur peak
    expect(el.style.filter).not.toBe('') // normally: mid-melt

    setReducedMotion(true)
    handle.setProgress(0.6) // a new value (an unchanged one is ignored by the state machine)
    expect(el.style.filter).toBe('none') // snapped to the end: no blur in between
  })

  it("a click goes straight to 'active' in one step", () => {
    setReducedMotion(true)
    el = document.createElement('button')
    document.body.appendChild(el)
    handle = comice(el) as ComiceHandle
    handle.driver(packageClick({ toggle: true }))

    el.click()
    expect(handle.state).toBe('active')
  })

  it("distort's cursor-following field stays off; the media shows undistorted", () => {
    const originalGetContext = HTMLCanvasElement.prototype.getContext
    const active: number[] = []
    ;(HTMLCanvasElement.prototype as any).getContext = function (t: string) {
      if (t !== 'webgl2') return originalGetContext.call(this, t)
      const gl = createFakeGL2()
      const uniform1f = gl.uniform1f.bind(gl)
      gl.uniform1f = (loc: WebGLUniformLocation | null, v: number) => {
        if ((loc as unknown as { __id: string } | null)?.__id === 'u_pointerActive') active.push(v)
        uniform1f(loc, v)
      }
      return gl
    }
    try {
      setReducedMotion(true)
      const img = document.createElement('img')
      Object.defineProperty(img, 'complete', { value: true })
      Object.defineProperty(img, 'naturalWidth', { value: 800 })
      el = img
      document.body.appendChild(img)
      handle = comice(img) as ComiceHandle
      handle.use(distort({ effect: 'bulge' }))
      handle.transition('entering')
      handle.transition('active')

      expect(active.length).toBeGreaterThan(0)
      expect(active.every((v) => v === 0)).toBe(true)
    } finally {
      HTMLCanvasElement.prototype.getContext = originalGetContext
    }
  })
})
