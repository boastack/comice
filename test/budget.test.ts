/**
 * test/budget — packages/core/src/budget.ts, spec §13's frame clock
 * ─────────────────────────────────────────────────────────────────────────────
 * "Watch the frame clock: step down resolution, then chain length, then a
 * static poster if frames keep missing budget." Not built until now.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  isPoster,
  qualityLevel,
  recordFrame,
  renderScale,
  resetQuality,
  setAdaptiveQuality,
} from '../packages/core/src/budget.js'
import { createGLContext, effectiveDPR } from '../packages/core/src/gl/context.js'
import { createVisibilityGate } from '../packages/core/src/scheduler.js'
import { createFakeGL2 } from './fake-webgl2.js'
import { installFakeIntersectionObserver, type FakeIntersection } from './fake-intersection.js'

/** One decision window (a second of frames) at a steady frame time. */
function window(ms: number): void {
  for (let elapsed = 0; elapsed < 1000; elapsed += ms) recordFrame(ms)
}

/** Two slow seconds in a row: what one step down takes. */
function slowStep(): void {
  window(33)
  window(33)
}

beforeEach(() => {
  setAdaptiveQuality(true)
  resetQuality()
})
afterEach(() => {
  setAdaptiveQuality(true)
  resetQuality()
})

describe('stepping', () => {
  it('starts at full quality', () => {
    expect(qualityLevel()).toBe(0)
    expect(renderScale()).toBe(1)
    expect(isPoster()).toBe(false)
  })

  it('two seconds in a row under ~40fps step down one level: 75%, then 50%, then a poster', () => {
    slowStep() // ~30fps
    expect([qualityLevel(), renderScale()]).toEqual([1, 0.75])
    slowStep()
    expect([qualityLevel(), renderScale()]).toEqual([2, 0.5])
    slowStep()
    expect(qualityLevel()).toBe(3)
    expect(isPoster()).toBe(true)
  })

  it('ONE slow second (page load: decoding, shader compiles) does not step down', () => {
    window(33)
    expect(qualityLevel()).toBe(0)
    window(16) // then the page settles
    window(33) // a later lone slow second starts the count over
    expect(qualityLevel()).toBe(0)
  })

  it('decides once per second of frames, not per slow frame — so a 5fps page decides in 5 frames, not 60', () => {
    for (let i = 0; i < 5; i++) recordFrame(200) // one second at 5fps
    for (let i = 0; i < 4; i++) recordFrame(200) // 800ms into the next
    expect(qualityLevel()).toBe(0)
    recordFrame(200) // the second slow second is up: 10 frames, not 120
    expect(qualityLevel()).toBe(1)
  })

  it('steps back up only after TWO fast windows in a row', () => {
    slowStep()
    expect(qualityLevel()).toBe(1)
    window(16) // one fast window: not enough
    expect(qualityLevel()).toBe(1)
    window(16)
    expect(qualityLevel()).toBe(0)
  })

  it('a middling window resets the run of fast ones', () => {
    slowStep()
    window(16) // fast
    window(21) // neither slow nor fast: the run of fast windows starts over
    window(16) // only one fast in a row now
    expect(qualityLevel()).toBe(1)
  })

  it('the poster is sticky: with nothing drawing, frames look fast — recovering would flip straight back', () => {
    slowStep()
    slowStep()
    slowStep()
    expect(isPoster()).toBe(true)
    window(8)
    window(8)
    window(8)
    expect(isPoster()).toBe(true)
  })

  it('ignores pauses over a second (a tab switch, a debugger) and non-positive deltas', () => {
    for (let i = 0; i < 120; i++) recordFrame(1500)
    for (let i = 0; i < 120; i++) recordFrame(0)
    expect(qualityLevel()).toBe(0)
  })

  it('setAdaptiveQuality(false) pins full quality and clears any step taken', () => {
    slowStep()
    expect(qualityLevel()).toBe(1)
    setAdaptiveQuality(false)
    expect(qualityLevel()).toBe(0)
    slowStep()
    slowStep()
    expect(qualityLevel()).toBe(0)
  })
})

describe('what the steps actually change', () => {
  const originalGetContext = HTMLCanvasElement.prototype.getContext
  let intersection: FakeIntersection

  beforeEach(() => {
    ;(HTMLCanvasElement.prototype as any).getContext = function (type: string) {
      if (type === 'webgl2') return createFakeGL2()
      return originalGetContext.call(this, type)
    }
    intersection = installFakeIntersectionObserver()
  })
  afterEach(() => {
    HTMLCanvasElement.prototype.getContext = originalGetContext
    intersection.uninstall()
  })

  it('a resolution step shrinks every canvas backing store on its next resize', () => {
    const root = document.createElement('div')
    document.body.appendChild(root)
    const context = createGLContext(root)!
    Object.defineProperty(context.canvas, 'clientWidth', { value: 400, configurable: true })
    Object.defineProperty(context.canvas, 'clientHeight', { value: 200, configurable: true })

    context.resizeToDisplay()
    const fullWidth = context.canvas.width
    slowStep()
    slowStep() // 50%
    context.resizeToDisplay()

    expect(effectiveDPR()).toBeCloseTo(Math.min(window_dpr(), 2) * 0.5)
    expect(context.canvas.width).toBe(Math.round(fullWidth * 0.5))
    root.remove()
  })

  it('at the poster level, shouldDraw() turns false while the element stays visible', () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const gate = createVisibilityGate(el)
    expect(gate.shouldDraw()).toBe(true)

    slowStep()
    slowStep()
    slowStep()

    expect(gate.isVisible()).toBe(true) // still on screen (e.g. the audio driver keeps running)
    expect(gate.shouldDraw()).toBe(false) // but GPU drawing stops; the canvas holds its last frame
    gate.destroy()
    el.remove()
  })
})

function window_dpr(): number {
  return globalThis.window?.devicePixelRatio || 1
}

describe('very slow pages', () => {
  beforeEach(() => resetQuality())
  afterEach(() => resetQuality())

  it('a 3fps page (333ms frames) still steps down — its frames are slow, not pauses', () => {
    for (let i = 0; i < 8; i++) recordFrame(333) // two seconds at 3fps
    expect(qualityLevel()).toBe(1)
  })
})
