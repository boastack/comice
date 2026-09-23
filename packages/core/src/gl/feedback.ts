/**
 * comice/core/gl/feedback
 * ─────────────────────────────────────────────────────────────────────────────
 * T4 (ROADMAP.md §4): temporal feedback. Spec §07: "The previous frame,
 * available to the current one. A ping-pong buffer pair allocated once at
 * setup, never per frame. Trails, echo, ghosting, persistence, smear and
 * feedback distortion are all the same capability with different decay and
 * offset. footage's echo is one consumer, not the owner."
 *
 * This file is that buffer pair. It does not know what a trail, an echo or
 * a smear is — those are decay/offset choices a future consumer (footage's
 * `echo`, and whatever else lands in ROADMAP.md's T11) makes by how it
 * blends the previous frame into the current one. What this file owns is
 * making "the previous frame" a safe, cheap thing to ask for at all:
 *
 *   1. Two RGBA render targets, not one — the shader reading last frame's
 *      result can never be the same target the current frame writes to;
 *      reading and writing the same texture in one draw call is undefined
 *      behavior in WebGL2 (a feedback loop the spec explicitly forbids).
 *   2. Swap by pointer, not by copy — advancing to the next frame means
 *      relabeling which target is "read" and which is "write," never
 *      copying pixels between them.
 *   3. Allocated once, released on destroy() — per §07's own callout,
 *      "Temporal feedback is the single easiest place in this whole plan
 *      to leak textures, because the naive implementation allocates a
 *      target every frame and looks correct while doing it."
 *
 * RGBA, not the R8 single-channel format mask.ts's render targets use —
 * a mask is one value per texel by definition, but the previous FRAME is
 * a full rendered image (color, alpha, whatever the current pass produced),
 * so this file's render-target allocation is written separately from
 * mask.ts's rather than shared, even though both wrap
 * createTexture/createFramebuffer — the pixel format they need is
 * genuinely different, not an accident of two people writing similar code.
 */

import { effectiveDPR } from './context.js'
import type { GLContext } from './context.js'

type RenderTarget = {
  texture: WebGLTexture
  framebuffer: WebGLFramebuffer
  width: number
  height: number
}

function createRenderTarget(gl: WebGL2RenderingContext, width: number, height: number): RenderTarget | null {
  const texture = gl.createTexture()
  const framebuffer = gl.createFramebuffer()
  if (!texture || !framebuffer) return null

  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  // RGBA8: a full previous-frame color buffer, not a single-channel mask —
  // see the file header for why this is deliberately not mask.ts's R8
  // helper.
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)

  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)

  return { texture, framebuffer, width, height }
}

function destroyRenderTarget(gl: WebGL2RenderingContext, target: RenderTarget): void {
  gl.deleteTexture(target.texture)
  gl.deleteFramebuffer(target.framebuffer)
}

/**
 * A ping-pong buffer pair. `read` is last frame's result — bind its
 * `.texture` as a sampler input. `write` is this frame's destination —
 * bind its `.framebuffer` as the render target. Call `swap()` once, after
 * a frame finishes drawing into `write`, to advance: what was `write`
 * becomes next frame's `read`, and vice versa.
 */
export type FeedbackBuffer = {
  /** Last frame's completed result. Sample this as a texture input. */
  readonly read: { readonly texture: WebGLTexture }
  /** This frame's render target. Bind this framebuffer and draw into it —
   *  never into `read`'s framebuffer, which would be exactly the
   *  same-texture read/write feedback loop WebGL2 forbids. */
  readonly write: { readonly framebuffer: WebGLFramebuffer }
  /** Relabels read/write for the next frame — a pointer swap, not a pixel
   *  copy. Call once per frame, after the current frame's draw into
   *  `write` has completed. */
  swap(): void
  /**
   * Resizes both buffers to match `cssWidth`/`cssHeight` × the §13 DPR cap
   * (gl/context.ts's `effectiveDPR()`). A no-op if the target size hasn't
   * changed, so a caller may call this every frame cheaply, matching
   * `GLContext.resizeToDisplay()`'s own contract. A resize clears both
   * buffers' contents (a genuinely new allocation, not a resample) —
   * callers that need continuity across a resize (an in-flight trail,
   * say) are a consumer-level decision about what "resize mid-effect"
   * should look like, not this primitive's to make.
   */
  resize(cssWidth: number, cssHeight: number): void
  /** Releases both underlying render targets. Idempotent. */
  destroy(): void
}

/**
 * Creates a ping-pong FeedbackBuffer pair against `context`, sized for
 * `cssWidth`/`cssHeight` (CSS pixels) at creation time — call `resize()`
 * again on layout changes, same pattern as `GLContext.resizeToDisplay()`.
 *
 * Degrade-never-disappear: if `context` is null (no WebGL2), or if
 * allocating either render target fails, returns a FeedbackBuffer whose
 * `read`/`write` point at inert placeholder objects (`texture`/
 * `framebuffer` both `null`) and whose `swap()`/`resize()` are no-ops. A
 * consumer that binds a null texture/framebuffer gets WebGL2's own
 * "sampling an incomplete texture reads black/transparent, drawing into a
 * null framebuffer target does nothing" behavior — degraded, not crashed,
 * matching every other producer in this package.
 */
export function createFeedbackBuffer(context: GLContext | null, cssWidth: number, cssHeight: number): FeedbackBuffer {
  let destroyed = false

  function inert(): FeedbackBuffer {
    return {
      read: { texture: null as unknown as WebGLTexture },
      write: { framebuffer: null as unknown as WebGLFramebuffer },
      swap() {},
      resize() {},
      destroy() {},
    }
  }

  if (!context) return inert()

  const { gl } = context
  const dpr = effectiveDPR()
  let width = Math.max(1, Math.round(cssWidth * dpr))
  let height = Math.max(1, Math.round(cssHeight * dpr))

  let bufferA = createRenderTarget(gl, width, height)
  let bufferB = createRenderTarget(gl, width, height)
  if (!bufferA || !bufferB) {
    // Partial allocation failure: release whichever one DID succeed
    // rather than leaking it, then degrade — same "clean up what you
    // already have before giving up" discipline as elsewhere in this
    // package's error paths.
    if (bufferA) destroyRenderTarget(gl, bufferA)
    if (bufferB) destroyRenderTarget(gl, bufferB)
    return inert()
  }

  // readIndex tracks which of the two buffers is "last frame's result"
  // (read) vs "this frame's destination" (write). Swapping flips this
  // flag — a pointer relabel, never a pixel copy, per the file header.
  let readIsA = true

  return {
    get read() {
      const target = readIsA ? bufferA! : bufferB!
      return { texture: target.texture }
    },
    get write() {
      const target = readIsA ? bufferB! : bufferA!
      return { framebuffer: target.framebuffer }
    },
    swap(): void {
      if (destroyed) return
      readIsA = !readIsA
    },
    resize(nextCssWidth: number, nextCssHeight: number): void {
      if (destroyed) return
      const nextDpr = effectiveDPR()
      const nextWidth = Math.max(1, Math.round(nextCssWidth * nextDpr))
      const nextHeight = Math.max(1, Math.round(nextCssHeight * nextDpr))
      if (nextWidth === width && nextHeight === height) return // no-op, matches resizeToDisplay()

      // A genuinely new allocation per buffer, not a resample of the old
      // contents — see the resize() doc comment on FeedbackBuffer above
      // for why continuity across a resize is left to the consumer.
      const nextA = createRenderTarget(gl, nextWidth, nextHeight)
      const nextB = createRenderTarget(gl, nextWidth, nextHeight)
      if (!nextA || !nextB) {
        // Allocation failed: keep the existing (old-sized) buffers rather
        // than leaving this FeedbackBuffer with no targets at all —
        // degrade to "stale size," never to "broken."
        if (nextA) destroyRenderTarget(gl, nextA)
        if (nextB) destroyRenderTarget(gl, nextB)
        return
      }

      destroyRenderTarget(gl, bufferA!)
      destroyRenderTarget(gl, bufferB!)
      bufferA = nextA
      bufferB = nextB
      width = nextWidth
      height = nextHeight
    },
    destroy(): void {
      if (destroyed) return
      destroyed = true
      destroyRenderTarget(gl, bufferA!)
      destroyRenderTarget(gl, bufferB!)
    },
  }
}
