/**
 * @comice/seed
 * ─────────────────────────────────────────────────────────────────────────────
 * Everything before media is ready — spec §08's own words: "Placeholders,
 * priority, decoding, art direction." T9 (ROADMAP.md §4).
 *
 * THREE PLACEHOLDER FORMATS, ALL SHIPPED: `thumbhash` (default, "about 25
 * bytes, handles transparency" — see thumbhash.ts for the from-scratch
 * decoder), `blurhash` (see blurhash.ts), `lqip` (a tiny base64 JPEG/PNG
 * data URI a build step already produced — no decoder needed, it's already
 * a real image, just blurred and scaled up via CSS while the real media
 * loads).
 *
 * NOT AN IMAGE CDN OR BUILD TOOL, PER SPEC'S OWN EXCLUDES: seed never
 * generates a hash/lqip from the source image itself — it only decodes and
 * displays a hash/data-URI the caller already has (from a build step, a
 * CMS field, whatever produced it upstream). "Consumes the sources given
 * to it, does not resize or host."
 *
 * FOCAL: `[x, y]` (0..1, matches CSS object-position's own coordinate
 * convention) sets object-position directly. `'subject'` is NOT
 * implemented this pass — it needs `vision`'s segmentation (Phase 4, not
 * built), same honest gap `dof` left out of `@comice/color` for the same
 * reason. Passing `focal: 'subject'` throws at construction rather than
 * silently falling back to center-crop, so a caller relying on it fails
 * loudly instead of shipping a quietly-wrong crop.
 *
 * PRIORITY + DECODING: `priority` sets `loading`/`fetchPriority` hints on
 * the target (the real browser-native mechanism for "load this one
 * first" — no custom prioritization queue reinvented here). The
 * placeholder-to-real-media crossfade waits for the SAME real decode
 * signal reveal's own decode.ts uses (HTMLImageElement.decode() /
 * <video>'s loadeddata), never a guessed delay — "never reveal a blank
 * frame" is section 08's reveal card language, and it applies exactly as
 * much to a placeholder that outstays its welcome.
 */

import type { ComiceInstance, ComicePlugin } from 'comice'
import { blurHashToRGBA } from './blurhash.js'
import { thumbHashToRGBA } from './thumbhash.js'

export type SeedPlaceholder = 'thumbhash' | 'blurhash' | 'lqip'

export type SeedOptions = {
  /** Which placeholder format decodes `hash`/`lqip`. Default 'thumbhash',
   *  matching spec exactly. */
  placeholder?: SeedPlaceholder
  /** The encoded hash string — a base64 ThumbHash, or a raw BlurHash
   *  string. Required when `placeholder` is 'thumbhash' or 'blurhash'. */
  hash?: string
  /** A tiny data: URI (or any small image URL) to use directly as the
   *  low-quality placeholder. Required when `placeholder` is 'lqip'. */
  lqip?: string
  /** Crop anchor, matching CSS object-position's own [x, y] 0..1
   *  convention. 'subject' is not implemented this pass — see the file
   *  header. Default [0.5, 0.5], matching spec exactly. */
  focal?: readonly [number, number] | 'subject'
  /** Hints the browser to fetch this media with elevated priority
   *  (`fetchPriority: 'high'`, `loading: 'eager'`) rather than the
   *  default lazy/auto behavior. Default false. */
  priority?: boolean
  /** BlurHash decode target size, px. Larger reproduces more detail but
   *  costs more CPU at setup(); the result is stretched to the element's
   *  actual size via CSS regardless. Default 32. */
  blurhashSize?: number
}

type Uploadable = HTMLImageElement | HTMLVideoElement

function isUploadableSource(target: Element): target is Uploadable {
  return target instanceof HTMLImageElement || target instanceof HTMLVideoElement
}

/** True once `el` is known-ready to paint without a blank/placeholder
 *  frame — same mechanism reveal's own decode.ts uses, reimplemented here
 *  rather than imported since packages don't depend on sibling plugin
 *  packages, only on `comice` core (see ROADMAP.md's package boundaries). */
function isAlreadyReady(el: Uploadable): boolean {
  if (el instanceof HTMLImageElement) {
    return el.complete && el.naturalWidth > 0
  }
  const HAVE_CURRENT_DATA = 2
  return el.readyState >= HAVE_CURRENT_DATA
}

function waitForMediaReady(target: Uploadable): Promise<void> {
  if (isAlreadyReady(target)) return Promise.resolve()

  if (target instanceof HTMLImageElement) {
    if (typeof target.decode === 'function') {
      return target.decode().catch(
        () =>
          new Promise<void>((resolve) => {
            const onSettle = () => {
              target.removeEventListener('load', onSettle)
              target.removeEventListener('error', onSettle)
              resolve()
            }
            target.addEventListener('load', onSettle, { once: true })
            target.addEventListener('error', onSettle, { once: true })
          }),
      )
    }
    return new Promise<void>((resolve) => {
      const onSettle = () => {
        target.removeEventListener('load', onSettle)
        target.removeEventListener('error', onSettle)
        resolve()
      }
      target.addEventListener('load', onSettle, { once: true })
      target.addEventListener('error', onSettle, { once: true })
    })
  }

  return new Promise<void>((resolve) => {
    const onSettle = () => {
      target.removeEventListener('loadeddata', onSettle)
      target.removeEventListener('error', onSettle)
      resolve()
    }
    target.addEventListener('loadeddata', onSettle, { once: true })
    target.addEventListener('error', onSettle, { once: true })
  })
}

/** Renders a small RGBA bitmap to a data: URI via an offscreen canvas, for
 *  use as a CSS background-image. Returns null, never throws, if 2D canvas
 *  isn't available — degrade-never-disappear: no placeholder image means
 *  the element just shows nothing until the real media decodes, same as
 *  browsers already do with no seed() at all. */
function rgbaToDataUrl(width: number, height: number, rgba: Uint8ClampedArray): string | null {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const imageData = ctx.createImageData(width, height)
  imageData.data.set(rgba)
  ctx.putImageData(imageData, 0, 0)
  try {
    return canvas.toDataURL()
  } catch {
    // toDataURL can throw in a tainted-canvas environment — extremely
    // unlikely here (the bitmap is synthesized, never sourced from a
    // cross-origin image), but degrade rather than throw regardless.
    return null
  }
}

function decodePlaceholder(options: SeedOptions): string | null {
  const { placeholder = 'thumbhash', hash, lqip, blurhashSize = 32 } = options

  if (placeholder === 'lqip') {
    return lqip ?? null
  }

  if (placeholder === 'thumbhash') {
    if (!hash) return null
    const binary = typeof atob === 'function' ? atob(hash) : Buffer.from(hash, 'base64').toString('binary')
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    const decoded = thumbHashToRGBA(bytes)
    return rgbaToDataUrl(decoded.width, decoded.height, decoded.rgba)
  }

  // blurhash
  if (!hash) return null
  const decoded = blurHashToRGBA(hash, blurhashSize, blurhashSize)
  return rgbaToDataUrl(decoded.width, decoded.height, decoded.rgba)
}

export function seed(options: SeedOptions = {}): ComicePlugin {
  const { focal = [0.5, 0.5], priority = false } = options

  if (focal === 'subject') {
    // Fails loudly at construction rather than silently center-cropping —
    // see the file header's FOCAL section.
    throw new Error("[comice] seed(): focal: 'subject' needs @comice/vision, which does not exist yet. Pass an explicit [x, y] instead.")
  }

  let target: Uploadable | null = null
  let originalStyle: { objectPosition: string; backgroundImage: string; backgroundSize: string; backgroundPosition: string; filter: string; transition: string; loading: string; fetchPriority: string } | null = null
  let destroyed = false

  return {
    name: 'seed',

    setup(rawTarget: Element, instance: ComiceInstance) {
      if (!isUploadableSource(rawTarget)) {
        throw new Error('[comice] seed() requires an <img> or <video> target.')
      }
      target = rawTarget

      originalStyle = {
        objectPosition: target.style.objectPosition,
        backgroundImage: target.style.backgroundImage,
        backgroundSize: target.style.backgroundSize,
        backgroundPosition: target.style.backgroundPosition,
        filter: target.style.filter,
        transition: target.style.transition,
        loading: target instanceof HTMLImageElement ? target.loading : '',
        fetchPriority: (target as HTMLImageElement).fetchPriority ?? '',
      }

      const [fx, fy] = focal
      target.style.objectPosition = `${fx * 100}% ${fy * 100}%`

      if (priority) {
        if (target instanceof HTMLImageElement) {
          target.loading = 'eager'
          try {
            target.fetchPriority = 'high'
          } catch {
            // fetchPriority is a relatively new IDL attribute — absent in
            // older engines. Setting the loading hint above already
            // covers the meaningful part of "load this first" on those.
          }
        }
      }

      const placeholderUrl = decodePlaceholder(options)
      if (placeholderUrl) {
        // The placeholder paints as a background behind the (still
        // invisible-until-decoded) real media, scaled to cover and
        // gently blurred — the standard "blur-up" treatment every one of
        // spec's three placeholder formats shares, regardless of which
        // decoder produced the tiny bitmap.
        target.style.backgroundImage = `url(${placeholderUrl})`
        target.style.backgroundSize = 'cover'
        target.style.backgroundPosition = `${focal[0] * 100}% ${focal[1] * 100}%`
        target.style.filter = 'blur(20px)'
        target.style.transition = 'filter 0.4s ease-out'
      }

      waitForMediaReady(target).then(() => {
        if (destroyed || !target) return
        // Real media has decoded — clear the placeholder's blur so the
        // sharp image takes over. The background-image is left in place
        // (harmless once opaque real content paints over it) rather than
        // removed, avoiding a redundant reflow for no visible benefit.
        target.style.filter = ''
        // `ready` lifecycle event (spec §04): the real media is showing.
        instance.ready('seed')
      })
    },

    teardown() {
      destroyed = true
      if (target && originalStyle) {
        target.style.objectPosition = originalStyle.objectPosition
        target.style.backgroundImage = originalStyle.backgroundImage
        target.style.backgroundSize = originalStyle.backgroundSize
        target.style.backgroundPosition = originalStyle.backgroundPosition
        target.style.filter = originalStyle.filter
        target.style.transition = originalStyle.transition
        if (target instanceof HTMLImageElement) {
          target.loading = originalStyle.loading === 'eager' ? 'eager' : 'lazy'
          try {
            if (originalStyle.fetchPriority) {
              // Had a real, explicit value before setup() — put it back.
              target.fetchPriority = originalStyle.fetchPriority as 'high' | 'low' | 'auto'
            } else {
              // Never had fetchpriority set before setup() — removing
              // the reflected content attribute is the real "put it back
              // exactly as it was" for an IDL-reflected attribute (the
              // IDL type itself has no empty-string member to assign, so
              // 'auto'/'' would both be values Comice invented on its
              // way out rather than a true restore).
              target.removeAttribute('fetchpriority')
            }
          } catch {
            // See setup()'s own try/catch — same degrade.
          }
        }
      }
      target = null
      originalStyle = null
    },
  }
}

