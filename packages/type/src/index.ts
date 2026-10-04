/**
 * @comice/type
 * ─────────────────────────────────────────────────────────────────────────────
 * Media and live text meeting, and text behaving like media — spec §08's
 * own words: "The text stays real DOM, selectable, styleable, indexable."
 * T10 (ROADMAP.md §4). Pure CSS/DOM, no WebGL canvas anywhere in this
 * plugin — see gooey.ts's own header for why `melt` in particular stays
 * CSS-filter-based rather than shader-based, per spec's explicit wording.
 *
 * TARGET: the target IS the text element (an <h1>, a project name span,
 * whatever real DOM node holds the text) — `target: string` (a selector
 * for the MEDIA element it meets, resolved relative to the document, not
 * the text target) supplies the media side, since spec's own examples
 * pair a text element with a separately-selected media element rather
 * than nesting one inside the other.
 *
 * FOUR MODES:
 *   'fill'     — the media clips to the text's own glyph shapes
 *                (background-clip: text), so the text reads as if it's
 *                made of the media. Default, matching spec.
 *   'behind'   — the media sits behind the text (z-index layering), the
 *                text simply overlaps it — the simplest mode, no filter
 *                trickery needed.
 *   'knockout' — the text cuts a hole OUT of the media rather than being
 *                filled by it (mix-blend-mode: destination-out via a
 *                dedicated compositing layer), the inverse of 'fill'.
 *   'melt'     — melt.ts. Change the element's text and it melts from
 *                the old word into the new (gooey cross-fade + alpha
 *                threshold); driven progress scrubs the last pair.
 */

import type { ComiceInstance, ComicePlugin } from 'comice'
import { snapForReducedMotion } from 'comice'
import type { MeltOptions } from './gooey.js'
import { createMelt, type Melt } from './melt.js'

export type TypeMode = 'fill' | 'behind' | 'knockout' | 'melt'

export type TypeOptions = {
  /** Default 'fill', matching spec exactly. */
  mode?: TypeMode
  /** A selector (resolved against `document`) for the media element this
   *  text meets. Required for 'fill'/'behind'/'knockout'; ignored for
   *  'melt' (melt operates on the text element alone, morphing between
   *  its own content states). */
  media?: string
  /** `{ blur, threshold, curve, hold, duration }` — see gooey.ts. Change
   *  the element's text and it melts from the old word into the new. */
  melt?: MeltOptions
}

function resolveMediaElement(selector: string | undefined): HTMLElement | null {
  if (!selector) return null
  return document.querySelector<HTMLElement>(selector)
}

export function type(options: TypeOptions = {}): ComicePlugin {
  const { mode = 'fill', media: mediaSelector, melt } = options

  if ((mode === 'fill' || mode === 'behind' || mode === 'knockout') && !mediaSelector) {
    throw new Error(`[comice] type(): mode '${mode}' requires a \`media\` selector.`)
  }

  let target: HTMLElement | null = null
  let mediaEl: HTMLElement | null = null
  let unsubscribe: (() => void) | null = null
  let originalStyle: { backgroundImage: string; backgroundClip: string; webkitBackgroundClip: string; color: string; mixBlendMode: string; position: string; zIndex: string; filter: string } | null = null
  let currentProgress = 0
  let melter: Melt | null = null

  function applyFill(): void {
    if (!target || !mediaEl) return
    const src = mediaEl instanceof HTMLImageElement ? mediaEl.src : ''
    target.style.backgroundImage = src ? `url(${src})` : ''
    target.style.backgroundSize = 'cover'
    target.style.backgroundClip = 'text'
    ;(target.style as CSSStyleDeclaration & { webkitBackgroundClip?: string }).webkitBackgroundClip = 'text'
    target.style.color = 'transparent'
  }

  function applyBehind(): void {
    if (!target || !mediaEl) return
    const parent = mediaEl.parentElement
    if (parent && getComputedStyle(parent).position === 'static') {
      parent.style.position = 'relative'
    }
    target.style.position = 'relative'
    target.style.zIndex = '1'
  }

  function applyKnockout(): void {
    if (!target) return
    target.style.mixBlendMode = 'destination-out'
  }

  function render(progress: number): void {
    // Reduced motion: jump to whichever end state is closer, never animate between.
    currentProgress = Math.max(0, Math.min(1, snapForReducedMotion(progress)))
    melter?.scrub(currentProgress)
  }

  return {
    name: 'type',
    // A fresh, identically configured copy, for comice('.many') giving every
    // matched element its own instance (see core's ComicePlugin.create).
    create: () => type(options),

    setup(rawTarget: Element, instance: ComiceInstance) {
      if (!(rawTarget instanceof HTMLElement)) {
        throw new Error('[comice] type() requires an HTMLElement target.')
      }
      target = rawTarget
      mediaEl = resolveMediaElement(mediaSelector)

      if ((mode === 'fill' || mode === 'behind' || mode === 'knockout') && !mediaEl) {
        throw new Error(`[comice] type(): no element matched the \`media\` selector "${mediaSelector}".`)
      }

      originalStyle = {
        backgroundImage: target.style.backgroundImage,
        backgroundClip: target.style.backgroundClip,
        webkitBackgroundClip: (target.style as CSSStyleDeclaration & { webkitBackgroundClip?: string }).webkitBackgroundClip ?? '',
        color: target.style.color,
        mixBlendMode: target.style.mixBlendMode,
        position: target.style.position,
        zIndex: target.style.zIndex,
        filter: target.style.filter,
      }

      switch (mode) {
        case 'fill':
          applyFill()
          break
        case 'behind':
          applyBehind()
          break
        case 'knockout':
          applyKnockout()
          break
        case 'melt':
          melter = createMelt(target, melt)
          break
      }

      // Driven progress scrubs the last melt; only real progress changes
      // (not state or lifecycle events, which would snap it back to the
      // old word).
      unsubscribe = instance.on('progress', (snapshot) => {
        render(snapshot.progress)
      })
      // `ready` lifecycle event (spec §04): no GPU work to wait for, so this
      // plugin's effect is in place once setup has run.
      instance.ready('type')
    },

    teardown() {
      unsubscribe?.()
      melter?.destroy()
      melter = null
      if (target && originalStyle) {
        target.style.backgroundImage = originalStyle.backgroundImage
        target.style.backgroundClip = originalStyle.backgroundClip
        ;(target.style as CSSStyleDeclaration & { webkitBackgroundClip?: string }).webkitBackgroundClip = originalStyle.webkitBackgroundClip
        target.style.color = originalStyle.color
        target.style.mixBlendMode = originalStyle.mixBlendMode
        target.style.position = originalStyle.position
        target.style.zIndex = originalStyle.zIndex
        target.style.filter = originalStyle.filter
      }
      target = null
      mediaEl = null
      originalStyle = null
    },

    // MappableTarget: `progress` drives melt's blur/contrast animation;
    // a no-op for the other three modes (they have no progress-driven
    // behavior — setting it simply doesn't render anything different),
    // matching color's own "some params only matter for some configs"
    // precedent.
    params: {
      getParam(name: string): number {
        if (name === 'progress') return currentProgress
        return 0
      },
      setParam(name: string, value: number): void {
        if (name !== 'progress') return
        render(value)
      },
    },
  }
}

export type { MeltCurve, MeltOptions } from './gooey.js'
