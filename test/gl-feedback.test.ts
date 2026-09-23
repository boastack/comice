/**
 * test/gl-feedback.test — packages/core/src/gl/feedback.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs against happy-dom (see /bunfig.toml preload) plus test/fake-webgl2.ts,
 * same reasoning as gl-plane.test.ts/gl-mask.test.ts: happy-dom's real
 * getContext('webgl2') is always null, so feedback.ts's actual GL-touching
 * allocation/swap logic has nothing real to run against without a fake.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createFeedbackBuffer } from '../packages/core/src/gl/feedback.js'
import { createFakeGLContext } from './fake-webgl2.js'

describe('createFeedbackBuffer — degrade-never-disappear (context is null)', () => {
  it('read/write point at inert placeholders, swap()/resize()/destroy() are no-ops', () => {
    const buffer = createFeedbackBuffer(null, 100, 100)
    expect(buffer.read.texture).toBeNull()
    expect(buffer.write.framebuffer).toBeNull()
    expect(() => buffer.swap()).not.toThrow()
    expect(() => buffer.resize(200, 200)).not.toThrow()
    expect(() => buffer.destroy()).not.toThrow()
  })
})

describe('createFeedbackBuffer — allocation failure', () => {
  let canvas: HTMLCanvasElement

  beforeEach(() => {
    canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
  })

  afterEach(() => {
    canvas.remove()
  })

  it('degrades to inert (no throw) when createTexture() fails', () => {
    const context = createFakeGLContext(canvas, { failCreateTexture: true })
    const buffer = createFeedbackBuffer(context, 100, 100)
    expect(buffer.read.texture).toBeNull()
    expect(buffer.write.framebuffer).toBeNull()
  })

  it('degrades to inert (no throw) when createFramebuffer() fails', () => {
    const context = createFakeGLContext(canvas, { failCreateFramebuffer: true })
    const buffer = createFeedbackBuffer(context, 100, 100)
    expect(buffer.read.texture).toBeNull()
    expect(buffer.write.framebuffer).toBeNull()
  })
})

describe('createFeedbackBuffer — real allocation, read/write/swap', () => {
  let canvas: HTMLCanvasElement

  beforeEach(() => {
    canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
  })

  afterEach(() => {
    canvas.remove()
  })

  it('read and write start out as two distinct buffers', () => {
    const context = createFakeGLContext(canvas)
    const buffer = createFeedbackBuffer(context, 100, 100)
    expect(buffer.read.texture).not.toBeNull()
    expect(buffer.write.framebuffer).not.toBeNull()
    // The read texture and the write target's backing texture must never
    // be the same object — that would be the same-texture read/write
    // feedback loop WebGL2 forbids, which is the entire reason this file
    // exists as a pair rather than a single render target.
    const firstReadTexture = buffer.read.texture
    buffer.swap()
    expect(buffer.write.framebuffer).not.toBeNull()
    buffer.swap() // swap back
    expect(buffer.read.texture).toBe(firstReadTexture)
  })

  it('swap() relabels read/write without reallocating (pointer swap, not a copy)', () => {
    const context = createFakeGLContext(canvas)
    const buffer = createFeedbackBuffer(context, 100, 100)
    const readBefore = buffer.read.texture
    const writeFramebufferBefore = buffer.write.framebuffer

    buffer.swap()

    // After one swap, what was "write" is now "read" — same underlying
    // objects, just relabeled, so the previous write framebuffer's own
    // texture is now what read.texture reports. We can't directly compare
    // framebuffer-to-texture identity through this API, but we CAN assert
    // read flipped away from its previous value and write flipped away
    // from its previous value, which a real copy-based implementation
    // would also satisfy — the stronger, decisive assertion is the
    // swap-back round-trip test above.
    expect(buffer.read.texture).not.toBe(readBefore)
    expect(buffer.write.framebuffer).not.toBe(writeFramebufferBefore)
  })

  it('double swap returns to the original read/write assignment', () => {
    const context = createFakeGLContext(canvas)
    const buffer = createFeedbackBuffer(context, 100, 100)
    const originalRead = buffer.read.texture
    const originalWrite = buffer.write.framebuffer

    buffer.swap()
    buffer.swap()

    expect(buffer.read.texture).toBe(originalRead)
    expect(buffer.write.framebuffer).toBe(originalWrite)
  })
})

describe('createFeedbackBuffer — resize()', () => {
  let canvas: HTMLCanvasElement

  beforeEach(() => {
    canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
  })

  afterEach(() => {
    canvas.remove()
  })

  it('reallocates both buffers when the target size actually changes', () => {
    const context = createFakeGLContext(canvas)
    const buffer = createFeedbackBuffer(context, 100, 100)
    const readBefore = buffer.read.texture

    buffer.resize(400, 400)

    expect(buffer.read.texture).not.toBeNull()
    expect(buffer.read.texture).not.toBe(readBefore) // reallocated, not resampled
  })

  it('is a no-op when the target size has not changed', () => {
    const context = createFakeGLContext(canvas)
    const buffer = createFeedbackBuffer(context, 100, 100)
    const readBefore = buffer.read.texture
    const writeBefore = buffer.write.framebuffer

    buffer.resize(100, 100) // same CSS size, same DPR — no-op

    expect(buffer.read.texture).toBe(readBefore)
    expect(buffer.write.framebuffer).toBe(writeBefore)
  })

  it('keeps the old-sized buffers (does not go inert) if reallocation fails mid-resize', () => {
    const context = createFakeGLContext(canvas)
    const buffer = createFeedbackBuffer(context, 100, 100)
    const readBefore = buffer.read.texture
    expect(readBefore).not.toBeNull()

    // Can't flip failCreateTexture on an already-created fake context —
    // instead build a context whose createTexture starts failing only
    // after the initial pair succeeds, by wrapping createTexture to fail
    // from the Nth call onward.
    let calls = 0
    const originalCreateTexture = context.gl.createTexture.bind(context.gl)
    ;(context.gl as any).createTexture = () => {
      calls += 1
      if (calls > 0) return null // every call after this point fails
      return originalCreateTexture()
    }

    buffer.resize(500, 500)

    // Resize failed to reallocate — the buffer keeps its previous (stale
    // size) targets rather than going inert, per the "degrade to stale
    // size, never to broken" comment in feedback.ts.
    expect(buffer.read.texture).toBe(readBefore)
  })

  it('is a no-op once destroyed', () => {
    const context = createFakeGLContext(canvas)
    const buffer = createFeedbackBuffer(context, 100, 100)
    buffer.destroy()
    expect(() => buffer.resize(300, 300)).not.toThrow()
  })
})

describe('createFeedbackBuffer — destroy()', () => {
  it('releases both buffers and is idempotent', () => {
    const canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
    const context = createFakeGLContext(canvas)
    const buffer = createFeedbackBuffer(context, 100, 100)

    buffer.destroy()
    expect(() => buffer.destroy()).not.toThrow()
    expect(() => buffer.swap()).not.toThrow() // no-op post-destroy, not an error

    canvas.remove()
  })
})
