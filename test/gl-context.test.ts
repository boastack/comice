/**
 * test/gl-context.test — packages/core/src/gl/context.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs against happy-dom (see /bunfig.toml preload). happy-dom's
 * canvas.getContext('webgl2') returns null — that is not a test limitation
 * here, it IS the "WebGL2 unsupported" case this file's degrade-never-
 * disappear contract exists for, so these tests exercise the real fallback
 * path rather than mocking a browser that lacks WebGL2.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createGLContext, effectiveDPR, hasGLContext, mountCanvas } from '../packages/core/src/gl/context.js'
import { createFakeGL2, type LoseContextSpy } from './fake-webgl2.js'

describe('createGLContext — no WebGL2 available (happy-dom)', () => {
  let root: HTMLElement

  beforeEach(() => {
    root = document.createElement('div')
    document.body.appendChild(root)
  })

  afterEach(() => {
    root.remove()
  })

  it('returns null rather than throwing when getContext("webgl2") is unavailable', () => {
    expect(() => createGLContext(root)).not.toThrow()
    expect(createGLContext(root)).toBeNull()
  })

  it('does not register a context for `root` when creation fails', () => {
    createGLContext(root)
    expect(hasGLContext(root)).toBe(false)
  })
})

describe('createGLContext — root not attached to a document', () => {
  it('returns null for a detached element without throwing', () => {
    const detached = document.createElement('div')
    expect(() => createGLContext(detached)).not.toThrow()
    expect(createGLContext(detached)).toBeNull()
  })
})

describe('createGLContext — reuse semantics', () => {
  let root: HTMLElement

  beforeEach(() => {
    root = document.createElement('div')
    document.body.appendChild(root)
  })

  afterEach(() => {
    root.remove()
  })

  it('a second call with the same root does not create a second canvas (still null here, same code path)', () => {
    const first = createGLContext(root)
    const second = createGLContext(root)
    expect(first).toBe(second) // both null, but exercises the "existing" early-return branch
  })
})

describe('hasGLContext', () => {
  it('is false for a root nothing has been created against', () => {
    const root = document.createElement('div')
    expect(hasGLContext(root)).toBe(false)
  })
})

describe('createGLContext — a browser that DOES support WebGL2', () => {
  // happy-dom's canvas.getContext('webgl2') is unconditionally null (see
  // the describe block above), so the success path — the one every real
  // browser actually takes — is exercised here by patching getContext for
  // this block only, restored in afterEach. This is not testing a mock of
  // our own code; it's supplying the one browser API happy-dom doesn't
  // implement so createGLContext's real logic (registration, destroy(),
  // hasGLContext) runs for real.
  const originalGetContext = HTMLCanvasElement.prototype.getContext
  let loseContextSpy: LoseContextSpy

  beforeEach(() => {
    loseContextSpy = { called: false }
    ;(HTMLCanvasElement.prototype as any).getContext = function (type: string) {
      // withLoseContextExtension: true so destroy() exercises the real
      // `loseContext?.loseContext()` call, not just its optional-chaining
      // no-op branch (see the plain describe block above for that case).
      if (type === 'webgl2') return createFakeGL2({ withLoseContextExtension: true }, loseContextSpy)
      return originalGetContext.call(this, type)
    }
  })

  afterEach(() => {
    HTMLCanvasElement.prototype.getContext = originalGetContext
  })

  it('returns a GLContext and registers it against hasGLContext', () => {
    const root = document.createElement('div')
    document.body.appendChild(root)

    const context = createGLContext(root)
    expect(context).not.toBeNull()
    expect(hasGLContext(root)).toBe(true)

    root.remove()
  })

  it('a second call with the same root returns the exact same GLContext (reuse, not a second canvas)', () => {
    const root = document.createElement('div')
    document.body.appendChild(root)

    const first = createGLContext(root)
    const second = createGLContext(root)
    expect(first).toBe(second)

    root.remove()
  })

  it('destroy() removes the canvas and unregisters from hasGLContext, and is idempotent', () => {
    const root = document.createElement('div')
    document.body.appendChild(root)

    const context = createGLContext(root)!
    expect(hasGLContext(root)).toBe(true)

    context.destroy()
    expect(hasGLContext(root)).toBe(false)
    expect(loseContextSpy.called).toBe(true) // the real WEBGL_lose_context.loseContext() call happened
    expect(() => context.destroy()).not.toThrow() // second call is a no-op, not an error
  })

  it('resizeToDisplay() sizes the backing store to the canvas CSS box times effectiveDPR()', () => {
    const root = document.createElement('div')
    document.body.appendChild(root)

    const context = createGLContext(root)!
    Object.defineProperty(context.canvas, 'clientWidth', { value: 320, configurable: true })
    Object.defineProperty(context.canvas, 'clientHeight', { value: 240, configurable: true })

    context.resizeToDisplay()

    const dpr = effectiveDPR()
    expect(context.canvas.width).toBe(Math.round(320 * dpr))
    expect(context.canvas.height).toBe(Math.round(240 * dpr))

    root.remove()
  })

  it('resizeToDisplay() is a no-op once destroyed', () => {
    const root = document.createElement('div')
    document.body.appendChild(root)

    const context = createGLContext(root)!
    context.destroy()
    const widthBefore = context.canvas.width
    expect(() => context.resizeToDisplay()).not.toThrow()
    expect(context.canvas.width).toBe(widthBefore)

    root.remove()
  })
})

describe('createGLContext — destroy() when WEBGL_lose_context is unavailable', () => {
  const originalGetContext = HTMLCanvasElement.prototype.getContext

  beforeEach(() => {
    // No withLoseContextExtension here — getExtension() falls through to
    // its `return null` branch, and destroy()'s `loseContext?.loseContext()`
    // takes the optional-chaining no-op path instead.
    ;(HTMLCanvasElement.prototype as any).getContext = function (type: string) {
      if (type === 'webgl2') return createFakeGL2()
      return originalGetContext.call(this, type)
    }
  })

  afterEach(() => {
    HTMLCanvasElement.prototype.getContext = originalGetContext
  })

  it('destroy() does not throw when the browser has no WEBGL_lose_context extension', () => {
    const root = document.createElement('div')
    document.body.appendChild(root)

    const context = createGLContext(root)!
    expect(() => context.destroy()).not.toThrow()
    expect(hasGLContext(root)).toBe(false)

    root.remove()
  })
})

describe('mountCanvas — real bugs found on harness/site/ in Chromium', () => {
  const originalGetContext = HTMLCanvasElement.prototype.getContext
  let parent: HTMLElement
  let target: HTMLElement

  function setOffsets(el: HTMLElement, left: number, top: number, width: number, height: number): void {
    Object.defineProperty(el, 'offsetLeft', { value: left, configurable: true })
    Object.defineProperty(el, 'offsetTop', { value: top, configurable: true })
    Object.defineProperty(el, 'offsetWidth', { value: width, configurable: true })
    Object.defineProperty(el, 'offsetHeight', { value: height, configurable: true })
  }

  beforeEach(() => {
    ;(HTMLCanvasElement.prototype as any).getContext = function (type: string) {
      if (type === 'webgl2') return createFakeGL2()
      return originalGetContext.call(this, type)
    }
    parent = document.createElement('section')
    const heading = document.createElement('h2')
    target = document.createElement('div')
    parent.append(heading, target)
    document.body.appendChild(parent)
    setOffsets(target, 32, 160, 1136, 420)
  })

  afterEach(() => {
    HTMLCanvasElement.prototype.getContext = originalGetContext
    parent.remove()
  })

  it("sizes the canvas to the TARGET's own box, not 100% of its parent (which covered the section's heading and text)", () => {
    const context = createGLContext(target)!
    mountCanvas(context, target, { owner: 'dissolve', hideTarget: false })

    expect(target.nextElementSibling).toBe(context.canvas)
    const { left, top, width, height } = context.canvas.style
    expect([left, top, width, height]).toEqual(['32px', '160px', '1136px', '420px'])
  })

  it("makes a static parent the canvas's positioning root, leaving a positioned one alone", () => {
    parent.style.position = 'static' // happy-dom computes an unset position as '' rather than 'static'
    const context = createGLContext(target)!
    mountCanvas(context, target, { owner: 'dissolve', hideTarget: false })
    expect(parent.style.position).toBe('relative')

    const other = document.createElement('div')
    other.style.position = 'absolute'
    const inner = document.createElement('div')
    other.appendChild(inner)
    document.body.appendChild(other)
    mountCanvas(createGLContext(inner)!, inner, { owner: 'dissolve', hideTarget: false })
    expect(other.style.position).toBe('absolute')
    other.remove()
  })

  it('resizeToDisplay() keeps the canvas on the target when the layout around it moves', () => {
    const context = createGLContext(target)!
    mountCanvas(context, target, { owner: 'particles', hideTarget: false })

    setOffsets(target, 32, 220, 700, 360) // heading above wrapped to more lines; viewport narrowed
    context.resizeToDisplay()

    const { left, top, width, height } = context.canvas.style
    expect([left, top, width, height]).toEqual(['32px', '220px', '700px', '360px'])
  })

  it("hideTarget hides the target and release() restores the target's ORIGINAL visibility", () => {
    target.style.visibility = 'collapse' // whatever the page had set
    const context = createGLContext(target)!
    const mount = mountCanvas(context, target, { owner: 'distort', hideTarget: true })
    expect(target.style.visibility).toBe('hidden')

    mount.release()
    expect(target.style.visibility).toBe('collapse')
    expect(context.canvas.isConnected).toBe(false)
  })

  it('hideTarget: false never touches visibility', () => {
    const context = createGLContext(target)!
    const mount = mountCanvas(context, target, { owner: 'dissolve', hideTarget: false })
    expect(target.style.visibility).toBe('')
    mount.release()
    expect(target.style.visibility).toBe('')
  })

  it('refuses a second drawing plugin on the same element, naming both, BEFORE touching the DOM', () => {
    // Two shader plugins on one element never combined: each draws a full
    // quad from the raw media, so the last one silently replaced the other.
    const context = createGLContext(target)!
    mountCanvas(context, target, { owner: 'distort', hideTarget: true })
    const canvasCount = parent.querySelectorAll('canvas').length

    expect(() => mountCanvas(context, target, { owner: 'color', hideTarget: true })).toThrow(/color\(\).*distort\(\)/)
    expect(parent.querySelectorAll('canvas').length).toBe(canvasCount)
    expect(target.style.visibility).toBe('hidden') // still distort's, unchanged
  })

  it('release() is idempotent and frees the element for a new mount', () => {
    // A second release() must not re-remove a canvas a LATER mount put back,
    // or restore visibility over that later mount's `hidden`.
    const context = createGLContext(target)!
    const first = mountCanvas(context, target, { owner: 'mosaic', hideTarget: true })
    first.release()

    mountCanvas(context, target, { owner: 'ascii', hideTarget: true })
    first.release()

    expect(context.canvas.isConnected).toBe(true)
    expect(target.style.visibility).toBe('hidden')
  })

  it('resizeToDisplay() on an unmounted context does not touch the canvas box', () => {
    const context = createGLContext(target)!
    context.resizeToDisplay()
    expect(context.canvas.style.left).toBe('0px')
  })
})
