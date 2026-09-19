/**
 * @comice/reveal
 * ─────────────────────────────────────────────────────────────────────────────
 * Media entering, leaving and expanding — spec section 08's "the most
 * common media interaction on the web, in one place."
 *
 * THE FIRST COMICE PLUGIN, DELIBERATELY. Per section 18's build order:
 * "deliberately the least impressive plugin on the list, because it is CSS
 * and geometry with no shaders, and its only job here is to answer whether
 * .use(), setup(), teardown() and the params object a mapping writes into
 * actually hold up against a real consumer." Everything in this file exists
 * to exercise that contract, not to be an impressive effect.
 *
 * v0.1 SCOPE: wipe, scale, blur, blinds, slats, curtain, expand — all pure
 * CSS (clip-path/transform/filter), no shaders. `mask` is NOT implemented
 * here; it needs the shared mask field from spec section 07, which needs
 * the GPU pipeline, which does not exist yet (see ROADMAP.md section 2,
 * "Where we are right now"). Shipping a fake DOM-clip mask now would mean
 * throwing it away and rewriting it once the real mask field lands in
 * v0.2 — see effects.ts's header for the fuller reasoning.
 *
 * DRIVEN BY STATE, NOT DURATION. reveal reacts to the instance's
 * idle -> entering -> active -> leaving state machine via instance.on(),
 * the same "states, not durations" rule every Comice plugin follows —
 * there is no internal setTimeout standing in for "the animation is
 * probably done by now".
 */

import type { ComiceInstance, ComicePlugin } from 'comice'
import { computeEffectStyle, type RevealEffect } from './effects.js'
import { computeStaggerDelay, type StaggerOptions } from './stagger.js'
import { waitForMediaReady } from './decode.js'

export type RevealOptions = {
  /** Which CSS effect drives the reveal. Default 'scale'. Spec's default is
   *  'mask', but mask is out of v0.1 scope — see the file header. */
  effect?: RevealEffect
  /** Coordinates delay across sibling elements matched by the same selector. */
  stagger?: StaggerOptions
  /** Never reveal a blank frame: for an <img>/<video> target, holds the
   *  reveal at its 'idle' appearance until the real decode/loadeddata
   *  event fires, rather than a guessed delay. Default true. */
  waitForDecode?: boolean
}

const DEFAULT_EFFECT: RevealEffect = 'scale'

/** Reads the current inline style values this plugin owns, so setup() can
 *  restore them cleanly on teardown() rather than leaving stray inline
 *  styles behind on a DOM element the plugin no longer controls. */
function snapshotOwnedStyle(el: HTMLElement): Partial<CSSStyleDeclaration> {
  return {
    clipPath: el.style.clipPath,
    transform: el.style.transform,
    filter: el.style.filter,
    opacity: el.style.opacity,
  }
}

function applyStyle(el: HTMLElement, style: ReturnType<typeof computeEffectStyle>): void {
  if (style.clipPath !== undefined) el.style.clipPath = style.clipPath
  if (style.transform !== undefined) el.style.transform = style.transform
  if (style.filter !== undefined) el.style.filter = style.filter
  if (style.opacity !== undefined) el.style.opacity = style.opacity
}

/**
 * The idle-state rest appearance: fully hidden per the effect's own
 * direction (progress 0), so an element genuinely looks "not entered yet"
 * before any driver signal arrives, rather than flashing fully visible for
 * one frame first.
 */
function idleStyle(effect: RevealEffect): ReturnType<typeof computeEffectStyle> {
  return computeEffectStyle(effect, 0)
}

export function reveal(options: RevealOptions = {}): ComicePlugin {
  const { effect = DEFAULT_EFFECT, stagger, waitForDecode = true } = options

  let el: HTMLElement | null = null
  let unsubscribe: (() => void) | null = null
  let originalStyle: Partial<CSSStyleDeclaration> | null = null
  let ready = false
  let pendingProgress: number | null = null
  let currentProgress = 0
  let staggerTimer: ReturnType<typeof setTimeout> | null = null
  let destroyed = false

  function render(progress: number): void {
    currentProgress = Math.max(0, Math.min(1, progress))
    if (!el) return
    applyStyle(el, computeEffectStyle(effect, currentProgress))
  }

  function applyStaggerDelay(target: Element): number {
    if (!stagger) return 0
    return computeStaggerDelay(target, stagger)
  }

  return {
    name: 'reveal',

    setup(target, instance: ComiceInstance) {
      if (!(target instanceof HTMLElement)) {
        // reveal styles a DOM element directly — an SVG or other Element
        // subtype without a .style property can't be targeted. Fail
        // loudly rather than silently doing nothing, per the mapping
        // layer's own "programmer error throws" convention.
        throw new Error('[comice] reveal() requires an HTMLElement target.')
      }

      el = target
      originalStyle = snapshotOwnedStyle(el)
      applyStyle(el, idleStyle(effect))

      const delay = applyStaggerDelay(target)

      const start = () => {
        if (destroyed) return
        ready = true
        if (pendingProgress !== null) {
          render(pendingProgress)
          pendingProgress = null
        } else {
          render(instance.progress)
        }
      }

      const armReady = (): void => {
        if (delay > 0) {
          staggerTimer = setTimeout(start, delay)
        } else {
          start()
        }
      }

      if (waitForDecode) {
        waitForMediaReady(target).then(() => {
          if (!destroyed) armReady()
        })
      } else {
        armReady()
      }

      // Subscribe to every state/progress event. Before `ready`, incoming
      // progress is buffered rather than rendered, so a driver signal that
      // arrives mid-decode doesn't paint ahead of waitForDecode's promise.
      unsubscribe = instance.on('*', (snapshot) => {
        if (!ready) {
          pendingProgress = snapshot.progress
          return
        }
        render(snapshot.progress)
      })
    },

    teardown() {
      destroyed = true
      if (staggerTimer !== null) clearTimeout(staggerTimer)
      unsubscribe?.()
      if (el && originalStyle) {
        applyStyle(el, {
          clipPath: originalStyle.clipPath ?? '',
          transform: originalStyle.transform ?? '',
          filter: originalStyle.filter ?? '',
          opacity: originalStyle.opacity ?? '',
        })
      }
      el = null
      originalStyle = null
    },

    // MappableTarget: `progress` is reveal's one mappable parameter, same
    // pattern as the spec's dissolve card ("progress: number, Mappable, so
    // any driver can scrub the transition directly"). This is what
    // actually proves the params contract for real — a mapping written
    // into this object with no reveal-specific code on either side.
    params: {
      getParam(name: string): number {
        if (name === 'progress') return currentProgress
        return 0
      },
      setParam(name: string, value: number): void {
        if (name !== 'progress') return
        if (!ready) {
          pendingProgress = value
          return
        }
        render(value)
      },
    },
  }
}

export type { RevealEffect } from './effects.js'
export type { StaggerOptions } from './stagger.js'
