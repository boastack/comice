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
 * EFFECTS: wipe, scale, blur, blinds, slats, curtain, expand are pure CSS
 * (clip-path/transform/filter) on any element. `mask` draws the media on
 * the GPU through core's mask field (section 07) — a cursor, a shape,
 * text, another image or a video — so it needs an <img>/<video> target;
 * see mask.ts.
 *
 * DRIVEN BY STATE, NOT DURATION. reveal reacts to the instance's
 * idle -> entering -> active -> leaving state machine via instance.on(),
 * the same "states, not durations" rule every Comice plugin follows —
 * there is no internal setTimeout standing in for "the animation is
 * probably done by now".
 */

import type { ComiceInstance, ComicePlugin } from 'comice'
import { prefersReducedMotion, snapForReducedMotion } from 'comice'
import { getSharedScheduler } from 'comice/scheduler'
import { computeEffectStyle, type RevealEffect } from './effects.js'
import { computeStaggerDelay, type StaggerOptions } from './stagger.js'
import { waitForMediaReady } from './decode.js'
import { createMaskReveal, validateMaskSource, type MaskReveal, type RevealMaskSource } from './mask.js'

export type RevealOptions = {
  /** How the element enters. The CSS effects work on any element; 'mask'
   *  draws an <img>/<video> through `mask`. Default: 'mask' when a `mask`
   *  is given (spec's default), otherwise 'scale' — a mask effect with no
   *  mask would have nothing to reveal through. */
  effect?: RevealEffect | 'mask'
  /** For effect 'mask': a cursor, a shape, text, an image or a video.
   *  See mask.ts. 'subject' and 'depth' need @comice/vision. */
  mask?: RevealMaskSource
  /** Coordinates delay across sibling elements matched by the same selector. */
  stagger?: StaggerOptions
  /** Never reveal a blank frame: for an <img>/<video> target, holds the
   *  reveal at its 'idle' appearance until the real decode/loadeddata
   *  event fires, rather than a guessed delay. Default true. */
  waitForDecode?: boolean
  /** With no driver, how long reveal takes to play itself when the element
   *  comes into view, ms. Default 800. */
  duration?: number
}

/** With no driver, reveal plays once the element is this far into view. */
const PLAY_THRESHOLD = 0.15

const DEFAULT_CSS_EFFECT: RevealEffect = 'scale'

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
  const { stagger, waitForDecode = true, mask, duration = 800 } = options
  const effect = options.effect ?? (mask !== undefined ? 'mask' : DEFAULT_CSS_EFFECT)
  if (effect === 'mask') validateMaskSource(mask)

  let el: HTMLElement | null = null
  let unsubscribe: (() => void) | null = null
  let originalStyle: Partial<CSSStyleDeclaration> | null = null
  let ready = false
  let pendingProgress: number | null = null
  let currentProgress = 0
  let staggerTimer: ReturnType<typeof setTimeout> | null = null
  let destroyed = false
  let maskReveal: MaskReveal | null = null
  let viewObserver: IntersectionObserver | null = null
  let stopPlaying: (() => void) | null = null

  /** No driver: entering -> active over `duration`, eased out. */
  function play(instance: ComiceInstance): void {
    if (destroyed || instance.driven || instance.state !== 'idle') return
    instance.transition('entering')
    if (prefersReducedMotion()) {
      instance.transition('active')
      return
    }
    let start: number | null = null
    stopPlaying = getSharedScheduler().add(
      (deltaMs, timestamp) => {
        start ??= timestamp - Math.min(deltaMs, 16.67)
        const t = Math.min(1, (timestamp - start) / duration)
        instance.setProgress(1 - (1 - t) ** 3)
        if (t >= 1) {
          stopPlaying?.()
          stopPlaying = null
          instance.transition('active')
        }
      },
      () => !destroyed,
    )
  }

  /** No driver: wait for the element to come into view, then its stagger
   *  delay, then play — so a grid's stagger runs as the grid scrolls in. */
  function playOnView(target: Element, instance: ComiceInstance, delay: number): void {
    const go = () => {
      if (delay > 0) staggerTimer = setTimeout(() => play(instance), delay)
      else play(instance)
    }
    if (typeof IntersectionObserver === 'undefined') return go()
    viewObserver = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        viewObserver?.disconnect()
        viewObserver = null
        go()
      },
      { threshold: PLAY_THRESHOLD },
    )
    viewObserver.observe(target)
  }

  function render(progress: number): void {
    // Reduced motion: jump to whichever end state is closer, never animate between.
    currentProgress = Math.max(0, Math.min(1, snapForReducedMotion(progress)))
    if (maskReveal) {
      maskReveal.setProgress(currentProgress)
      return
    }
    if (!el || effect === 'mask') return
    applyStyle(el, computeEffectStyle(effect, currentProgress))
  }

  function applyStaggerDelay(target: Element): number {
    if (!stagger) return 0
    return computeStaggerDelay(target, stagger)
  }

  return {
    name: 'reveal',
    // A fresh, identically configured copy, for comice('.many') giving every
    // matched element its own instance (see core's ComicePlugin.create).
    create: () => reveal(options),

    setup(target, instance: ComiceInstance) {
      if (!(target instanceof HTMLElement)) {
        // reveal styles a DOM element directly — an SVG or other Element
        // subtype without a .style property can't be targeted. Fail
        // loudly rather than silently doing nothing, per the mapping
        // layer's own "programmer error throws" convention.
        throw new Error('[comice] reveal() requires an HTMLElement target.')
      }

      el = target
      if (effect === 'mask') {
        if (!(target instanceof HTMLImageElement || target instanceof HTMLVideoElement)) {
          throw new Error("[comice] reveal(): effect 'mask' draws the media itself, so it needs an <img> or <video> target.")
        }
        maskReveal = createMaskReveal(target, instance, mask!)
      } else {
        originalStyle = snapshotOwnedStyle(el)
        applyStyle(el, idleStyle(effect))
      }

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
        // `ready` lifecycle event (spec §04): the media is decoded and the
        // reveal is armed to play, never on a blank frame. The mask path
        // reports its own ready/error from the GPU (mask.ts).
        if (!maskReveal) instance.ready('reveal')
        // .driver() is chained after .use(): by the next microtask it has
        // run. With a driver, it sets the timing, as it always did. With
        // none, reveal plays itself on entering view — "media entering" is
        // what it owns. It used to stay hidden forever: the spec's own
        // `comice('.grid figure').use(reveal({ effect: 'blinds', ... }))`
        // was a blank grid.
        if (delay === 0) start() // armed at once; only the play decision waits
        queueMicrotask(() => {
          if (destroyed) return
          if (!instance.driven) {
            if (delay > 0) start()
            playOnView(target, instance, delay)
          } else if (delay > 0) {
            staggerTimer = setTimeout(start, delay)
          }
        })
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
      viewObserver?.disconnect()
      stopPlaying?.()
      unsubscribe?.()
      maskReveal?.destroy()
      maskReveal = null
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
export type { RevealMaskSource } from './mask.js'
export type { StaggerOptions } from './stagger.js'
