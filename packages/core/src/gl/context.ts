/**
 * comice/core/gl/context
 * ─────────────────────────────────────────────────────────────────────────────
 * Spec §01's actual premise: media goes on the graphics card as a texture on
 * a flat rectangle, not through the browser's own paint path. This is where
 * that starts — WebGL2 context creation, and nothing else. No draws, no
 * textures, no geometry here; see plane.ts for the part that puts a texture
 * on a rectangle.
 *
 * WebGL2 only, per spec §11/§17 — no WebGPU fallback, no dual backend. See
 * the spec artifact for the full reasoning; the short version is that a
 * second backend doubles the implementation of every primitive in §07
 * forever, for a capability none of the 18 plugins in §08 actually need.
 *
 * Rule 04, degrade-never-disappear, applies at the root: context creation
 * can fail (no WebGL2 support, too many contexts already live, a headless
 * test DOM like happy-dom that returns null from getContext()). This module
 * never throws on that — it reports failure through the return value, and
 * callers decide what "degraded" means for them (currently: the plane never
 * renders, the source element is left exactly as the browser would have
 * shown it on its own).
 */

/** One WebGL2 context, shared by every Comice instance registered against
 *  the same root. Kept minimal on purpose — texture/program state lives in
 *  plane.ts, not here. */
export type GLContext = {
  readonly canvas: HTMLCanvasElement
  readonly gl: WebGL2RenderingContext
  /**
   * Resizes the canvas's backing store (`canvas.width`/`height`, the
   * actual pixel buffer WebGL renders into — distinct from its CSS
   * width/height, which are already 100%/100% of `root`) to match the
   * canvas's current CSS box times the §13 DPR cap (see
   * gl/residency.ts's `effectiveDPR()` — capped at 2, never the raw
   * `devicePixelRatio`, so a 3x display doesn't triple texture memory for
   * nothing beyond what a person can actually perceive at that density).
   * A no-op if the computed size hasn't changed since the last call, so a
   * caller may call this every frame cheaply rather than only on resize.
   */
  resizeToDisplay(): void
  /** Releases the underlying context via the WEBGL_lose_context extension,
   *  when the browser exposes it, and detaches the canvas. Idempotent. */
  destroy(): void
}

const contextsByRoot = new WeakMap<Element, GLContext>()

/**
 * Creates (or reuses) the one WebGL2 context for `root` — the element every
 * Comice instance under it shares a canvas with, per §13's mobile budget:
 * one context per page section, not one per instance. A second call with
 * the same `root` returns the same GLContext rather than creating another.
 *
 * Returns null, never throws, if:
 *  - the browser/environment doesn't support WebGL2 (getContext returns
 *    null — this is also exactly what happy-dom's canvas does today, which
 *    is what test/gl-context.test.ts exercises as "no WebGL2" rather than
 *    mocking a browser that lacks it)
 *  - `root` is not attached to a document (nothing to size the canvas against)
 *
 * Callers on the no-WebGL2 path are expected to leave the source element
 * exactly as the browser already renders it — that is what "degrade, never
 * disappear" means for a rendering primitive: the fallback is the thing the
 * browser was already doing before Comice touched it.
 */

/** §13: "Scale resolution — cap device pixel ratio at 1.5 to 2 rather than
 *  honouring 3x displays." 2 is the upper bound of that stated range —
 *  texture/framebuffer memory scales with the SQUARE of DPR (a 3x-vs-2x
 *  canvas is 2.25x the pixels, not 1.5x), so this picks the conservative
 *  end of the range rather than the midpoint. */
const MAX_DPR = 2

/**
 * The effective device pixel ratio any GPU-memory-sized allocation in this
 * package should use — never the raw `window.devicePixelRatio`. Exported
 * so residency.ts and any future render-target sizing (T3's rasterized/
 * derived mask targets, T4's feedback buffers) read the exact same number
 * rather than each computing their own cap.
 */
export function effectiveDPR(): number {
  const raw = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
  return Math.min(raw, MAX_DPR)
}
export function createGLContext(
  root: Element,
  options: { alpha?: boolean; antialias?: boolean } = {},
): GLContext | null {
  const existing = contextsByRoot.get(root)
  if (existing) return existing

  if (!root.ownerDocument || !root.isConnected) return null

  const canvas = root.ownerDocument.createElement('canvas')
  canvas.style.position = 'absolute'
  canvas.style.top = '0'
  canvas.style.left = '0'
  canvas.style.width = '100%'
  canvas.style.height = '100%'
  // Never intercepts pointer events meant for the DOM elements it's
  // standing in for — Comice tracks pointer/scroll/drag through the real
  // DOM element (see the drivers), never through the canvas itself.
  canvas.style.pointerEvents = 'none'

  const gl = canvas.getContext('webgl2', {
    alpha: options.alpha ?? true,
    antialias: options.antialias ?? true,
    premultipliedAlpha: true,
    preserveDrawingBuffer: false,
  }) as WebGL2RenderingContext | null

  if (!gl) return null

  let destroyed = false
  const context: GLContext = {
    canvas,
    gl,
    resizeToDisplay(): void {
      if (destroyed) return
      const dpr = effectiveDPR()
      const targetWidth = Math.max(1, Math.round(canvas.clientWidth * dpr))
      const targetHeight = Math.max(1, Math.round(canvas.clientHeight * dpr))
      if (canvas.width === targetWidth && canvas.height === targetHeight) return
      canvas.width = targetWidth
      canvas.height = targetHeight
      gl.viewport(0, 0, targetWidth, targetHeight)
    },
    destroy(): void {
      if (destroyed) return
      destroyed = true
      const loseContext = gl.getExtension('WEBGL_lose_context')
      loseContext?.loseContext()
      canvas.remove()
      contextsByRoot.delete(root)
    },
  }

  contextsByRoot.set(root, context)
  return context
}

/** True if `root` currently has a live GLContext registered against it. */
export function hasGLContext(root: Element): boolean {
  return contextsByRoot.has(root)
}
