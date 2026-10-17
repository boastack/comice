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

import { quietFor, renderScale } from '../budget.js'

/** One WebGL2 context, shared by every Comice instance registered against
 *  the same root. Kept minimal on purpose — texture/program state lives in
 *  plane.ts, not here. */
export type GLContext = {
  readonly canvas: HTMLCanvasElement
  readonly gl: WebGL2RenderingContext
  /**
   * Resizes the canvas's backing store (`canvas.width`/`height`, the
   * actual pixel buffer WebGL renders into — distinct from its CSS
   * width/height, which mountCanvas() keeps equal to its target's own
   * box, re-synced here first) to match the
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

/** Which plugin's canvas is currently on the page for a context, and over
 *  which element — at most one per context. See mountCanvas(). */
type MountState = {
  target: HTMLElement
  owner: string
  hid: boolean
  originalVisibility: string
  releaseParent(): void
}
const positionedParents = new WeakMap<HTMLElement, { original: string; count: number }>()
const mountsByCanvas = new WeakMap<HTMLCanvasElement, MountState>()

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
  // Times the frame budget's resolution step (budget.ts): 1 normally, lower
  // when the page keeps missing its frame budget. Every canvas, mask and
  // feedback target reads this, so they all step down together.
  return Math.min(raw, MAX_DPR) * renderScale()
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

  let gl: WebGL2RenderingContext | null
  try { gl = canvas.getContext('webgl2', {
    alpha: options.alpha ?? true,
    antialias: options.antialias ?? true,
    premultipliedAlpha: true,
    preserveDrawingBuffer: false,
  }) as WebGL2RenderingContext | null } catch { return null }

  if (!gl) return null

  const activeGL = gl
  let destroyed = false
  const context: GLContext = {
    canvas,
    gl,
    resizeToDisplay(): void {
      if (destroyed) return
      // Every drawing plugin calls this each frame, so it is also where the
      // canvas follows its target's box when the layout around it moves.
      const mount = mountsByCanvas.get(canvas)
      if (mount) syncCanvasBox(canvas, mount.target)
      const dpr = effectiveDPR()
      const targetWidth = Math.max(1, Math.round(canvas.clientWidth * dpr))
      const targetHeight = Math.max(1, Math.round(canvas.clientHeight * dpr))
      if (canvas.width === targetWidth && canvas.height === targetHeight) return
      canvas.width = targetWidth
      canvas.height = targetHeight
      activeGL.viewport(0, 0, targetWidth, targetHeight)
    },
    destroy(): void {
      if (destroyed) return
      destroyed = true
      const loseContext = activeGL.getExtension('WEBGL_lose_context')
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

/** Positions the canvas exactly over `target`'s own layout box. offset*
 *  values are relative to the offsetParent, which mountCanvas() makes the
 *  shared parent — the same containing block the absolutely-positioned
 *  canvas sibling resolves against. Offsets (not getBoundingClientRect)
 *  ignore transforms, so a canvas inside a transformed ancestor (a rail
 *  card) moves with it instead of double-applying the transform. Only
 *  writes when something changed, since this runs every frame. */
function syncCanvasBox(canvas: HTMLCanvasElement, target: HTMLElement): void {
  const style = canvas.style
  const targetStyle = getComputedStyle(target)
  // A fixed media element and its sibling canvas share the same fixed
  // containing block; an absolute sibling would scroll away from it.
  const position = targetStyle.position === 'fixed' ? 'fixed' : 'absolute'
  if (style.position !== position) style.position = position
  if (style.transform !== targetStyle.transform) style.transform = targetStyle.transform
  if (style.transformOrigin !== targetStyle.transformOrigin) style.transformOrigin = targetStyle.transformOrigin
  const left = `${target.offsetLeft}px`
  const top = `${target.offsetTop}px`
  const width = `${target.offsetWidth}px`
  const height = `${target.offsetHeight}px`
  if (style.left !== left) style.left = left
  if (style.top !== top) style.top = top
  if (style.width !== width) style.width = width
  if (style.height !== height) style.height = height
}

export type CanvasMount = {
  /** Removes the canvas and restores the target's own visibility. Idempotent. */
  release(): void
  /** For a canvas mounted with `hideTarget: false`, before its first real frame:
   *  whether the target shows under the still-empty canvas. A plugin shows it
   *  only while it looks exactly like the effect's current frame (an effect at
   *  the end that IS the media's own frame), and hides it otherwise, so the
   *  wrong shape is never on screen; no effect after reveal. release() restores. */
  holdTarget(visible: boolean): void
  /** The canvas has just drawn its first real frame: hand the page over to it,
   *  once (later calls do nothing). If the target is still showing, the canvas
   *  fades in over it, `fadeMs` long, and the target is hidden once it is fully
   *  in (an effect that arrives late eases in instead of switching); if the target is already hidden, the
   *  canvas fades in from empty. release() restores. */
  hideTarget(fadeMs?: number): void
  /** Finishes a handoff that is still fading right now: the target is hidden and the
   *  canvas fully in. For when what the target shows stops matching the canvas
   *  mid-fade, so it must not stay half-visible under it. No effect otherwise. */
  completeReveal(): void
}

/**
 * Puts `context`'s canvas on the page over `target` — the one place every
 * drawing plugin (distort, color, mosaic, ascii, morph, dissolve, particles)
 * does this, instead of each copying it.
 *
 * Real bugs this replaces, all found on harness/site/ in Chromium:
 *
 *  - SIZE: each plugin sized the canvas to 100% of the target's PARENT. For
 *    a container target (dissolve's stage, particles' target) that covered
 *    the whole section, heading and body text included. The canvas now
 *    matches the target's own box and follows it in resizeToDisplay().
 *
 *  - SHARED TEARDOWN: the context (and its one canvas) is shared per
 *    element, but every plugin removed the canvas on teardown and restored
 *    whatever visibility IT had saved — for the second plugin on an
 *    element, that was the first one's `hidden`. Tearing down any one of
 *    them blanked the element or pulled the canvas out from under the rest.
 *    Now one mount owns the canvas and the target's original visibility.
 *
 *  - STACKING: two drawing plugins on one element never combined — each
 *    draws a full-canvas quad from the raw media, so the last to draw
 *    replaced the other entirely (proven by screenshot hashes). Rather than
 *    silently discard an effect, a second mount THROWS, before touching the
 *    DOM, naming both plugins. Real compositing is a separate project.
 *
 * `hideTarget`: media plugins hide the element the canvas replaces;
 * container plugins (dissolve, particles) draw over a target that has no
 * content of its own to hide.
 */
export function mountCanvas(
  context: GLContext,
  target: HTMLElement,
  options: { owner: string; hideTarget: boolean },
): CanvasMount {
  const { canvas } = context
  const existing = mountsByCanvas.get(canvas)
  if (existing) {
    throw new Error(
      `[comice] ${options.owner}() can't draw on this element: ${existing.owner}() already does. ` +
        'Two shader effects on one element do not combine — the last to draw would replace the other. ' +
        'Use one GL effect per element (wrap the media and put the second effect on the wrapper).',
    )
  }

  const parent = target.parentElement
  let releaseParent = () => {}
  if (parent) {
    let positioning = positionedParents.get(parent)
    if (!positioning && getComputedStyle(parent).position === 'static') {
      positioning = { original: parent.style.position, count: 0 }
      positionedParents.set(parent, positioning)
      parent.style.position = 'relative'
    }
    if (positioning) {
      positioning.count++
      const owned = positioning
      releaseParent = () => {
        if (--owned.count > 0) return
        if (parent.style.position === 'relative') parent.style.position = owned.original
        positionedParents.delete(parent)
      }
    }
  }

  const state: MountState = {
    target,
    owner: options.owner,
    hid: options.hideTarget,
    originalVisibility: target.style.visibility,
    releaseParent,
  }
  if (options.hideTarget) target.style.visibility = 'hidden'
  target.insertAdjacentElement('afterend', canvas)
  syncCanvasBox(canvas, target)
  mountsByCanvas.set(canvas, state)
  // Hiding the media (visibility: hidden) takes it out of the accessibility tree,
  // so the canvas that replaces it speaks for it: the same name, as an image.
  // Explicitly decorative media (alt="") stays out of the tree, and media with
  // no name at all gets none invented. The canvas is removed on release, so
  // there is nothing to restore.
  const decorative = target instanceof HTMLImageElement && target.hasAttribute('alt') && target.alt === ''
  const name = target.getAttribute('aria-label') ?? (target instanceof HTMLImageElement ? target.alt : target.getAttribute('title'))
  if (decorative) canvas.setAttribute('aria-hidden', 'true')
  else if (name) {
    canvas.setAttribute('role', 'img')
    canvas.setAttribute('aria-label', name)
  }
  // Setup stalls a few frames; that is not a reason to lower quality (budget.ts).
  quietFor()

  let released = false
  let revealed = false
  let fades: Animation[] = []
  return {
    holdTarget(visible: boolean): void {
      if (released || revealed) return
      if (visible) {
        if (state.hid) target.style.visibility = state.originalVisibility
        state.hid = false
        return
      }
      if (!state.hid) state.originalVisibility = target.style.visibility
      state.hid = true
      target.style.visibility = 'hidden'
    },
    hideTarget(fadeMs = 0): void {
      if (released || revealed) return
      revealed = true
      const animated = fadeMs > 0 && typeof canvas.animate === 'function' && typeof target.animate === 'function'
      const timing = { duration: fadeMs, easing: 'cubic-bezier(.25, .1, .25, 1)' }
      // Web Animations rather than inline styles: nothing to restore afterwards,
      // and release() mid-fade just cancels them.
      if (state.hid) {
        // Already hidden (held empty): the canvas eases in from nothing.
        if (animated) fades = [canvas.animate([{ opacity: 0 }, { opacity: 1 }], timing)]
        return
      }
      state.originalVisibility = target.style.visibility
      state.hid = true
      const hide = () => { if (!released) target.style.visibility = 'hidden' }
      if (animated) {
        // The canvas fades in ON TOP of the media, which stays fully opaque underneath until
        // the canvas is fully in. Fading both at once adds up to less than the picture
        // (two half-transparent layers over a dark page dip to grey) and shows through.
        fades = [canvas.animate([{ opacity: 0 }, { opacity: 1 }], timing)]
        fades[0]!.onfinish = () => { hide(); fades = [] }
        return
      }
      hide()
    },
    completeReveal(): void {
      if (released || fades.length === 0) return
      fades.forEach((fade) => fade.cancel())
      fades = []
      target.style.visibility = 'hidden'
    },
    release(): void {
      if (released) return
      released = true
      fades.forEach((fade) => fade.cancel())
      fades = []
      canvas.remove()
      if (state.hid) target.style.visibility = state.originalVisibility
      mountsByCanvas.delete(canvas)
      state.releaseParent()
    },
  }
}
