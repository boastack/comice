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
import { createGLContext, effectiveDPR, hasGLContext } from '../packages/core/src/gl/context.js'
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
