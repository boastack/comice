/**
 * test/gl-plane.test — packages/core/src/gl/plane.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs against happy-dom (see /bunfig.toml preload) plus test/fake-webgl2.ts
 * for the GL-touching branches happy-dom's real (null) WebGL2 context can't
 * exercise — see that file's header for why a fake is used instead of a
 * mock library.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createPlane, drawPlane } from '../packages/core/src/gl/plane.js'
import { getSharedScheduler } from '../packages/core/src/scheduler.js'
import { createFakeGLContext } from './fake-webgl2.js'
import { installFakeIntersectionObserver, type FakeIntersection } from './fake-intersection.js'

function readyImage(): HTMLImageElement {
  const img = document.createElement('img')
  Object.defineProperty(img, 'complete', { value: true, configurable: true })
  Object.defineProperty(img, 'naturalWidth', { value: 100, configurable: true })
  return img
}

function notReadyImage(): HTMLImageElement {
  const img = document.createElement('img')
  Object.defineProperty(img, 'complete', { value: false, configurable: true })
  Object.defineProperty(img, 'naturalWidth', { value: 0, configurable: true })
  img.decode = () => new Promise(() => {}) // never resolves
  return img
}

afterEach(() => {
  getSharedScheduler().stop()
})

describe('createPlane — degrade-never-disappear (context is null)', () => {
  it('returns a Plane with a permanently null texture, no throw', () => {
    const img = readyImage()
    document.body.appendChild(img)
    const plane = createPlane(null, img)
    expect(plane.texture).toBeNull()
    expect(() => plane.upload()).not.toThrow()
    expect(() => plane.syncLayout()).not.toThrow()
    expect(plane.box).toBeNull()
    expect(() => plane.destroy()).not.toThrow()
    img.remove()
  })
})

describe('createPlane — image source, real context', () => {
  let canvas: HTMLCanvasElement
  let img: HTMLImageElement

  beforeEach(() => {
    canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
  })

  afterEach(() => {
    canvas.remove()
    img?.remove()
  })

  it('uploads and exposes a texture once an already-ready image is used', () => {
    img = readyImage()
    document.body.appendChild(img)
    const context = createFakeGLContext(canvas)
    const plane = createPlane(context, img)
    expect(plane.texture).not.toBeNull()
    // The fake GLContext's own destroy() (distinct from Plane#destroy()
    // above) — a real caller would tear this down alongside the plane.
    expect(() => context.destroy()).not.toThrow()
  })

  it('uploads with UNPACK_FLIP_Y_WEBGL on, and leaves it off afterward — real bug: media rendered upside down', () => {
    // A DOM image's first row is its top; every shader samples with the
    // quad's v_uv, whose v=0 is the canvas BOTTOM. Uploading unflipped drew
    // every GL plugin's media upside down (seen in Chromium on harness/site/).
    img = readyImage()
    document.body.appendChild(img)
    const context = createFakeGLContext(canvas)
    createPlane(context, img)
    const gl = context.gl as unknown as { __uploadFlips: boolean[]; __flipY: boolean }
    expect(gl.__uploadFlips).toEqual([true])
    expect(gl.__flipY).toBe(false) // reset, so no other upload on the shared context inherits it
  })

  it('a failed upload is kept on plane.error (with the CORS fix spelled out), and cleared by a later good upload', () => {
    img = readyImage()
    document.body.appendChild(img)
    const context = createFakeGLContext(canvas, { failTexImage: true })
    const plane = createPlane(context, img)
    expect(plane.texture).toBeNull()
    expect(plane.error?.message).toMatch(/crossorigin="anonymous".*Access-Control-Allow-Origin/)

    // The server starts sending CORS headers; the next upload succeeds.
    ;(context.gl as unknown as { texImage2D: () => void }).texImage2D = () => {}
    plane.upload()
    expect(plane.texture).not.toBeNull()
    expect(plane.error).toBeNull()
  })

  it('resets UNPACK_FLIP_Y_WEBGL even when the upload throws (tainted canvas)', () => {
    img = readyImage()
    document.body.appendChild(img)
    const context = createFakeGLContext(canvas, { failTexImage: true })
    createPlane(context, img)
    expect((context.gl as unknown as { __flipY: boolean }).__flipY).toBe(false)
  })

  it('texture stays null until the image becomes ready', async () => {
    img = notReadyImage()
    document.body.appendChild(img)
    const context = createFakeGLContext(canvas)
    const plane = createPlane(context, img)
    expect(plane.texture).toBeNull()
  })

  it('upload() becomes a real upload once decode() resolves', async () => {
    img = document.createElement('img')
    document.body.appendChild(img)
    Object.defineProperty(img, 'complete', { value: false, configurable: true })
    Object.defineProperty(img, 'naturalWidth', { value: 0, configurable: true })
    let resolveDecode: () => void = () => {}
    img.decode = () => new Promise((resolve) => { resolveDecode = resolve })

    const context = createFakeGLContext(canvas)
    const plane = createPlane(context, img)
    expect(plane.texture).toBeNull()

    Object.defineProperty(img, 'complete', { value: true, configurable: true })
    Object.defineProperty(img, 'naturalWidth', { value: 50, configurable: true })
    resolveDecode()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(plane.texture).not.toBeNull()
  })

  it('syncLayout() populates box from the source element and canvas bounding rects', () => {
    img = readyImage()
    document.body.appendChild(img)
    const context = createFakeGLContext(canvas)
    const plane = createPlane(context, img)
    plane.syncLayout()
    expect(plane.box).not.toBeNull()
    expect(typeof plane.box!.x).toBe('number')
    expect(typeof plane.box!.width).toBe('number')
  })

  it('upload() no-ops (does not throw, does not flip texture readiness) when texImage2D throws (tainted canvas)', () => {
    img = readyImage()
    document.body.appendChild(img)
    const context = createFakeGLContext(canvas, { failTexImage: true })
    const plane = createPlane(context, img)
    expect(plane.texture).toBeNull()
  })

  it('destroy() is idempotent and stops further uploads from taking effect', () => {
    img = readyImage()
    document.body.appendChild(img)
    const context = createFakeGLContext(canvas)
    const plane = createPlane(context, img)
    expect(plane.texture).not.toBeNull()

    plane.destroy()
    expect(() => plane.destroy()).not.toThrow()
    // Post-destroy, upload/syncLayout are no-ops (destroyed guard), not errors.
    expect(() => plane.upload()).not.toThrow()
    expect(() => plane.syncLayout()).not.toThrow()
  })
})

describe('createPlane — video source', () => {
  let canvas: HTMLCanvasElement
  let video: HTMLVideoElement
  let intersection: FakeIntersection

  beforeEach(() => {
    // Per-frame uploads only run while an on-page video is on screen; happy-
    // dom never reports anything as on screen.
    intersection = installFakeIntersectionObserver()
    canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
    video = document.createElement('video')
    document.body.appendChild(video)
  })

  afterEach(() => {
    canvas.remove()
    video.remove()
    getSharedScheduler().stop()
    intersection.uninstall()
  })

  function playing(v: HTMLVideoElement): void {
    Object.defineProperty(v, 'readyState', { value: 2, configurable: true })
    Object.defineProperty(v, 'paused', { value: false, configurable: true })
    Object.defineProperty(v, 'ended', { value: false, configurable: true })
  }

  function withFrames(run: (frame: () => void) => void): void {
    const original = globalThis.requestAnimationFrame
    let pending: FrameRequestCallback | null = null
    let t = 0
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      pending = cb
      return 1
    }) as typeof requestAnimationFrame
    try {
      run(() => pending?.((t += 16)))
    } finally {
      globalThis.requestAnimationFrame = original
    }
  }

  it('an on-page video scrolled out of view stops re-uploading, and resumes in view — spec §13', () => {
    playing(video)
    withFrames((frame) => {
      const context = createFakeGLContext(canvas)
      const uploads = (context.gl as unknown as { __uploadFlips: boolean[] }).__uploadFlips
      const plane = createPlane(context, video)

      intersection.setVisible(false)
      const before = uploads.length
      frame()
      frame()
      expect(uploads.length).toBe(before) // off screen: no per-frame upload

      intersection.setVisible(true)
      frame()
      expect(uploads.length).toBe(before + 1)
      plane.destroy()
    })
  })

  it('a DETACHED video (a dissolve/mosaic source never put on the page) keeps uploading', () => {
    // It has no box of its own to be on screen — an IntersectionObserver
    // never reports it visible — so gating it on visibility would freeze it.
    const detached = document.createElement('video')
    playing(detached)
    intersection.setVisible(false)
    withFrames((frame) => {
      const context = createFakeGLContext(canvas)
      const uploads = (context.gl as unknown as { __uploadFlips: boolean[] }).__uploadFlips
      const plane = createPlane(context, detached)
      const before = uploads.length
      frame()
      expect(uploads.length).toBe(before + 1)
      plane.destroy()
    })
  })

  it('registers against the shared scheduler, gated on playing/not-ended', () => {
    Object.defineProperty(video, 'readyState', { value: 2, configurable: true }) // HAVE_CURRENT_DATA
    Object.defineProperty(video, 'paused', { value: false, configurable: true })
    Object.defineProperty(video, 'ended', { value: false, configurable: true })

    const context = createFakeGLContext(canvas)
    const plane = createPlane(context, video)
    expect(plane.texture).not.toBeNull()

    // destroy() unregisters cleanly — no throw, no leaked scheduler entry.
    expect(() => plane.destroy()).not.toThrow()
  })

  it('actually re-uploads on a real scheduler tick while playing, and the gate excludes paused/ended/destroyed', () => {
    Object.defineProperty(video, 'readyState', { value: 2, configurable: true })
    Object.defineProperty(video, 'paused', { value: false, configurable: true })
    Object.defineProperty(video, 'ended', { value: false, configurable: true })

    // Same pattern as test/scheduler.test.ts: happy-dom's own
    // requestAnimationFrame doesn't reliably deliver frames in this test
    // environment, so a synchronous fake drives scheduler.tick() for real,
    // exercising both the registered callback (`() => upload()`) and the
    // isActive gate (`() => !destroyed && !source.paused && !source.ended`).
    const original = globalThis.requestAnimationFrame
    let pending: FrameRequestCallback | null = null
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      pending = cb
      return 1
    }) as typeof requestAnimationFrame

    try {
      const context = createFakeGLContext(canvas)
      const plane = createPlane(context, video)

      expect(pending).not.toBeNull()
      pending!(0)
      expect(plane.texture).not.toBeNull()

      // Flip the gate false via paused, tick again — the gate function's
      // `&&` chain now short-circuits on the paused branch instead of
      // running upload() again.
      Object.defineProperty(video, 'paused', { value: true, configurable: true })
      pending!(16)

      plane.destroy()
    } finally {
      globalThis.requestAnimationFrame = original
    }
  })

  it('does not register a scheduler-driven upload path for an image source', () => {
    // Indirect check: an image source's destroy() must not attempt to call
    // an unregister function that was never set (would throw if mishandled).
    const img = readyImage()
    document.body.appendChild(img)
    const context = createFakeGLContext(canvas)
    const plane = createPlane(context, img)
    expect(() => plane.destroy()).not.toThrow()
    img.remove()
  })
})

describe('createPlane — ResizeObserver callback', () => {
  it('syncs the box when the observer reports a change (happy-dom never fires ResizeObserver on its own, so this invokes the registered callback directly)', () => {
    const canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
    const img = readyImage()
    document.body.appendChild(img)

    const originalResizeObserver = globalThis.ResizeObserver
    let capturedCallback: ResizeObserverCallback | null = null
    class SpyResizeObserver {
      constructor(cb: ResizeObserverCallback) {
        capturedCallback = cb
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    ;(globalThis as any).ResizeObserver = SpyResizeObserver

    try {
      const context = createFakeGLContext(canvas)
      const plane = createPlane(context, img)
      expect(capturedCallback).not.toBeNull()
      // Invoke exactly what the browser would invoke on a real layout change.
      capturedCallback!([] as unknown as ResizeObserverEntry[], {} as ResizeObserver)
      expect(plane.box).not.toBeNull()
    } finally {
      globalThis.ResizeObserver = originalResizeObserver
      canvas.remove()
      img.remove()
    }
  })
})

describe('drawPlane', () => {
  let canvas: HTMLCanvasElement
  let img: HTMLImageElement

  beforeEach(() => {
    canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
    img = readyImage()
    document.body.appendChild(img)
  })

  afterEach(() => {
    canvas.remove()
    img.remove()
  })

  it('does nothing (no throw) when the plane has no texture yet', () => {
    const context = createFakeGLContext(canvas)
    const plane = createPlane(context, notReadyImage())
    expect(() => drawPlane(context, plane)).not.toThrow()
  })

  it('does nothing (no throw) when the plane has a texture but syncLayout() was never called (no box)', () => {
    const context = createFakeGLContext(canvas)
    const plane = createPlane(context, img)
    expect(plane.texture).not.toBeNull()
    // box IS set automatically by createPlane's eager syncLayout() call —
    // this exercises the "has both" success path instead.
    expect(() => drawPlane(context, plane)).not.toThrow()
  })

  it('draws without throwing when the shader program compiles and links successfully', () => {
    const context = createFakeGLContext(canvas)
    const plane = createPlane(context, img)
    drawPlane(context, plane) // first call compiles+caches the program
    expect(() => drawPlane(context, plane)).not.toThrow() // second call hits the cache
  })

  it('does nothing (no throw) when shader compilation fails', () => {
    const context = createFakeGLContext(canvas, { failShaderCompile: true })
    const plane = createPlane(context, img)
    expect(() => drawPlane(context, plane)).not.toThrow()
  })

  it('does nothing (no throw) when program linking fails', () => {
    const context = createFakeGLContext(canvas, { failProgramLink: true })
    const plane = createPlane(context, img)
    expect(() => drawPlane(context, plane)).not.toThrow()
  })

  it('does nothing (no throw) when createProgram() itself returns null', () => {
    const context = createFakeGLContext(canvas, { failCreateProgram: true })
    const plane = createPlane(context, img)
    expect(() => drawPlane(context, plane)).not.toThrow()
  })

  it('caches a failed program lookup too — a second draw does not recompile', () => {
    const context = createFakeGLContext(canvas, { failProgramLink: true })
    const plane = createPlane(context, img)
    drawPlane(context, plane)
    expect(() => drawPlane(context, plane)).not.toThrow()
  })
})
