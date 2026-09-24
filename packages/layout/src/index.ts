/**
 * @comice/layout
 * ─────────────────────────────────────────────────────────────────────────────
 * The page reacting to the media, rather than the media sitting inside
 * the page — spec §08's own words. T10 (ROADMAP.md §4). Pure CSS/DOM, no
 * WebGL — spec's own Excludes line is explicit about the ceiling here:
 * "Not a layout engine. Nudges existing CSS layout using shape data,
 * never replaces grid or flex."
 *
 * SCOPE: THREE OF THE CARD'S FOUR MODE CHIPS SHIP THIS PASS — `wrap`,
 * `avoid`, `anchor`. `crop` is NOT implemented: unlike every other T10
 * plugin's card, `layout`'s final spec text gives no options table at
 * all for any mode, only the four chips, one job sentence, and one
 * worked example (text wrapping a photo's outline) — `crop`'s own option
 * shape is genuinely undetermined from the spec artifact as written, and
 * guessing at API surface that might conflict with a future
 * clarification is worse than leaving an honest gap, the same standard
 * `color`'s `dof` and `seed`'s `focal: 'subject'` hold to for a
 * different reason (a missing primitive, not a missing spec detail —
 * both are documented, un-guessed gaps rather than silently-dropped
 * ones).
 *
 * `shape: 'contour'` (the person's-outline case spec's own worked
 * example describes) is ALSO not implemented — it needs `vision`'s
 * subject segmentation (Phase 4, not built), the same honest gap `color`/
 * `seed` already carry. `wrap`/`avoid` here ship `'rect'`/`'ellipse'`
 * shapes derived from the media's own layout box via CSS `shape-outside`
 * — real, useful geometry-based wrapping, just not contour-accurate to a
 * segmented subject yet.
 *
 * MECHANISM: CSS `shape-outside` (the browser's own text-wrapping-around-
 * a-shape primitive) driving `wrap`/`avoid`, applied to the MEDIA element
 * itself (which must be floated for `shape-outside` to have any effect at
 * all — a CSS constraint, not a Comice one). `anchor` positions a
 * separate target element relative to the media's own box edges via
 * plain absolute positioning, recomputed on resize.
 */

import type { ComiceInstance, ComicePlugin } from 'comice'

export type LayoutMode = 'wrap' | 'avoid' | 'anchor'

export type LayoutShapeKind = 'rect' | 'ellipse'

export type LayoutOptions = {
  /** Required. */
  mode: LayoutMode
  /** Geometry `wrap`/`avoid` compute `shape-outside` from. Default
   *  'ellipse' (a closer approximation of an arbitrary photo subject than
   *  a hard rectangle, without needing real segmentation). Ignored for
   *  'anchor'. */
  shape?: LayoutShapeKind
  /** Which side the media floats to, driving which side text wraps/
   *  avoids on. Default 'left'. Ignored for 'anchor'. */
  float?: 'left' | 'right'
  /** Gap between the media's shape boundary and wrapped/avoiding text,
   *  px. Default 16. Ignored for 'anchor'. */
  margin?: number
  /** `anchor` mode only: selector (resolved against `document`) for the
   *  element to position relative to the media. Required for 'anchor'. */
  target?: string
  /** `anchor` mode only: which edge of the media the target element is
   *  pinned to. Default 'bottom'. */
  edge?: 'top' | 'bottom' | 'left' | 'right'
  /** `anchor` mode only: offset from the chosen edge, px. Default 8. */
  offset?: number
}

type Uploadable = HTMLImageElement | HTMLVideoElement

function isUploadableSource(el: Element): el is Uploadable {
  return el instanceof HTMLImageElement || el instanceof HTMLVideoElement
}

// Two radii, not one. `ellipse(closest-side)` (a single radius) is not valid
// in Chromium's `ellipse()` grammar for either shape-outside or clip-path —
// CSS.supports() returns false for it, so assigning it through `el.style`
// is silently dropped and the text wraps a plain rectangle instead. A real
// bug found running layout() on harness/site/: happy-dom accepts any
// string, so the unit test passed while the real browser ignored it.
const ELLIPSE = 'ellipse(closest-side closest-side)'

function buildShapeOutside(shape: LayoutShapeKind, margin: number): string {
  if (shape === 'ellipse') return ELLIPSE
  return `inset(-${margin}px)`
}

export function layout(options: LayoutOptions): ComicePlugin {
  const { mode, shape = 'ellipse', float = 'left', margin = 16, target: targetSelector, edge = 'bottom', offset = 8 } = options

  if (mode === 'anchor' && !targetSelector) {
    throw new Error("[comice] layout(): mode 'anchor' requires a `target` selector.")
  }

  let mediaEl: HTMLElement | null = null
  let anchoredEl: HTMLElement | null = null
  let resizeObserver: ResizeObserver | null = null
  let originalMediaStyle: { float: string; shapeOutside: string; shapeMargin: string; clipPath: string } | null = null
  let originalAnchoredStyle: { position: string; top: string; left: string; right: string; bottom: string } | null = null

  function applyWrapOrAvoid(): void {
    if (!mediaEl) return
    mediaEl.style.float = float
    mediaEl.style.shapeMargin = `${margin}px`
    mediaEl.style.shapeOutside = buildShapeOutside(shape, margin)
    if (shape === 'ellipse') {
      mediaEl.style.clipPath = ELLIPSE
    }
  }

  function applyAnchor(): void {
    if (!mediaEl || !anchoredEl) return
    // mediaEl.offsetParent (not mediaEl.parentElement) would be the more
    // layout-accurate answer for "which ancestor does absolute
    // positioning resolve against" in a real browser, but it's null
    // whenever an ancestor is display:none and unimplemented entirely in
    // some DOM environments (this repo's own test harness, happy-dom,
    // among them) — parentElement is what every other plugin in this
    // repo already uses for the identical "make the nearest ancestor a
    // positioning root" job (morph/dissolve/distort/color/mosaic/ascii
    // all check `target.parentElement`), so this matches that established,
    // portable convention instead of introducing a second, less reliable
    // one just for this file.
    const parent = mediaEl.parentElement
    if (parent && getComputedStyle(parent).position === 'static') {
      parent.style.position = 'relative'
    }
    anchoredEl.style.position = 'absolute'

    const mediaRect = mediaEl.getBoundingClientRect()
    const parentRect = parent?.getBoundingClientRect() ?? { left: 0, top: 0 }
    const relLeft = mediaRect.left - parentRect.left
    const relTop = mediaRect.top - parentRect.top

    switch (edge) {
      case 'top':
        anchoredEl.style.left = `${relLeft}px`
        anchoredEl.style.top = `${relTop - offset}px`
        anchoredEl.style.transform = 'translateY(-100%)'
        break
      case 'bottom':
        anchoredEl.style.left = `${relLeft}px`
        anchoredEl.style.top = `${relTop + mediaRect.height + offset}px`
        break
      case 'left':
        anchoredEl.style.top = `${relTop}px`
        anchoredEl.style.left = `${relLeft - offset}px`
        anchoredEl.style.transform = 'translateX(-100%)'
        break
      case 'right':
        anchoredEl.style.top = `${relTop}px`
        anchoredEl.style.left = `${relLeft + mediaRect.width + offset}px`
        break
    }
  }

  function render(): void {
    if (mode === 'anchor') {
      applyAnchor()
    } else {
      applyWrapOrAvoid()
    }
  }

  return {
    name: 'layout',

    setup(rawTarget: Element, _instance: ComiceInstance) {
      if (!isUploadableSource(rawTarget)) {
        throw new Error('[comice] layout() requires an <img> or <video> target as the media element.')
      }
      mediaEl = rawTarget

      originalMediaStyle = {
        float: mediaEl.style.float,
        shapeOutside: mediaEl.style.shapeOutside,
        shapeMargin: mediaEl.style.shapeMargin,
        clipPath: mediaEl.style.clipPath,
      }

      if (mode === 'anchor') {
        anchoredEl = document.querySelector<HTMLElement>(targetSelector!)
        if (!anchoredEl) {
          throw new Error(`[comice] layout(): no element matched the \`target\` selector "${targetSelector}".`)
        }
        originalAnchoredStyle = {
          position: anchoredEl.style.position,
          top: anchoredEl.style.top,
          left: anchoredEl.style.left,
          right: anchoredEl.style.right,
          bottom: anchoredEl.style.bottom,
        }
      }

      render()

      resizeObserver = new ResizeObserver(() => render())
      resizeObserver.observe(mediaEl)
    },

    teardown() {
      resizeObserver?.disconnect()
      if (mediaEl && originalMediaStyle) {
        mediaEl.style.float = originalMediaStyle.float
        mediaEl.style.shapeOutside = originalMediaStyle.shapeOutside
        mediaEl.style.shapeMargin = originalMediaStyle.shapeMargin
        mediaEl.style.clipPath = originalMediaStyle.clipPath
      }
      if (anchoredEl && originalAnchoredStyle) {
        anchoredEl.style.position = originalAnchoredStyle.position
        anchoredEl.style.top = originalAnchoredStyle.top
        anchoredEl.style.left = originalAnchoredStyle.left
        anchoredEl.style.right = originalAnchoredStyle.right
        anchoredEl.style.bottom = originalAnchoredStyle.bottom
        anchoredEl.style.transform = ''
      }
      mediaEl = null
      anchoredEl = null
      resizeObserver = null
      originalMediaStyle = null
      originalAnchoredStyle = null
    },
  }
}
