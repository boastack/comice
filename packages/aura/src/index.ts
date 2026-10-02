/**
 * @comice/aura
 * ─────────────────────────────────────────────────────────────────────────────
 * Media colour escaping its frame — spec §08's own words: "Samples the
 * playing source and pushes colour into the page, as a glow, as CSS
 * variables, or as data." T10 (ROADMAP.md §4).
 *
 * TARGET, UNLIKE EVERY OTHER SHADER PLUGIN SO FAR: aura does NOT hide or
 * replace the target — the media keeps rendering exactly as the browser
 * already shows it (spec's own card never says aura changes how the
 * media itself looks). `setup()` creates a private, off-screen WebGL2
 * context purely to sample colors from the target, and never inserts a
 * visible canvas over it at all. This is the same "the source is read,
 * never re-rendered" shape `vision`'s own card describes for depth/
 * segmentation producers (Phase 4, not built) — aura is effectively the
 * COLOR-domain equivalent of that idea, built now because it needs no
 * ML, only a downsample + CPU-side clustering (sample.ts).
 *
 * THREE OUTPUTS, ALL THREE SHIP: "as a glow" — a radial box-shadow-style
 * glow element positioned behind the target; "as CSS variables" — writes
 * `--aura-color`/`--aura-color-1..N` onto the target's own style, so any
 * surrounding CSS can read them directly (spec's own "button colours...
 * shift" example is exactly this); "as data" — the `onSample` callback
 * option, so a caller can drive anything else (a canvas, a WebGL uniform
 * elsewhere) off the same live samples without aura needing to know what
 * that consumer does with them.
 *
 * CONTRAST CLAMPING IS NOT OPTIONAL BY DEFAULT, PER SPEC'S OWN EXCLUDES:
 * `contrast: false` is the only way to turn it off; every sampled color
 * pushed into a CSS variable is clamped against the page's own background
 * color (read via getComputedStyle of the target's nearest ancestor with
 * a non-transparent background) before it's written, via sample.ts's
 * `clampToContrast()`.
 */

import type { ComiceInstance, ComicePlugin } from 'comice'
import { createGLContext, createGLReporter, createPlane, type GLContext, type GLReporter, type Plane } from 'comice/gl'
import { createVisibilityGate, getSharedScheduler } from 'comice/scheduler'
import { createDownsampler, type Downsampler } from './downsample.js'
import { clampToContrast, sampleEdges, samplePalette, type RGB } from './sample.js'

export type AuraOptions = {
  /** Default 'edges', matching spec exactly. */
  sample?: 'edges' | 'palette'
  /** Number of dominant colors for `sample: 'palette'`. Ignored for
   *  'edges'. Default 5, matching spec's own example. */
  colors?: number
  /** Minimum contrast ratio pushed colors are clamped to, or `false` to
   *  disable clamping entirely. Default 4.5, matching spec exactly. */
  contrast?: number | false
  /** Renders a soft radial glow element behind the target, tinted by the
   *  current sample. Default true. */
  glow?: boolean
  /** Writes `--aura-color` (edges) or `--aura-color-0..N` (palette) as
   *  CSS custom properties on the target element. Default true. */
  cssVariables?: boolean
  /** Fires with the current sample every time it updates — spec's own
   *  "as... data" output. */
  onSample?: (colors: readonly RGB[]) => void
  /** How often to re-sample, in ms. Default 200 — frequent enough to
   *  track a playing video's mood, far below per-frame cost. */
  sampleIntervalMs?: number
}

function rgbToCss([r, g, b]: RGB): string {
  return `rgb(${r}, ${g}, ${b})`
}

/** Walks up from `el` to find the nearest ancestor (or el itself) with a
 *  real, non-transparent background-color, for contrast clamping against.
 *  Falls back to white — the safest assumption for "readable against most
 *  real pages" when nothing in the ancestor chain sets one explicitly. */
function nearestBackgroundColor(el: Element): RGB {
  let node: Element | null = el
  while (node) {
    const bg = getComputedStyle(node).backgroundColor
    const match = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(bg)
    if (match) {
      const alpha = match[4] !== undefined ? Number.parseFloat(match[4]) : 1
      if (alpha > 0) {
        return [Number.parseInt(match[1]!, 10), Number.parseInt(match[2]!, 10), Number.parseInt(match[3]!, 10)]
      }
    }
    node = node.parentElement
  }
  return [255, 255, 255]
}

type Uploadable = HTMLImageElement | HTMLVideoElement

function isUploadableSource(target: Element): target is Uploadable {
  return target instanceof HTMLImageElement || target instanceof HTMLVideoElement
}

export function aura(options: AuraOptions = {}): ComicePlugin {
  const { sample = 'edges', colors = 5, contrast = 4.5, glow = true, cssVariables = true, onSample, sampleIntervalMs = 200 } = options

  let target: Uploadable | null = null
  let glContext: GLContext | null = null
  let reporter: GLReporter | null = null
  let plane: Plane | null = null
  let downsampler: Downsampler | null = null
  let glowEl: HTMLDivElement | null = null
  let unregisterFromScheduler: (() => void) | null = null
  let visibility: ReturnType<typeof createVisibilityGate> | null = null
  let destroyed = false
  // `null` (not 0) means "never sampled yet" — a real rAF `timestamp` can
  // legitimately be a small number in the first few frames (or exactly 0
  // for the very first one, same footgun scheduler.ts's own `tick()` had
  // to guard against for its `hasTicked` flag), so 0 is not a safe
  // sentinel: it would silently skip the very first sample whenever
  // `timestamp - 0` happens to land under `sampleIntervalMs`.
  let lastSampleTime: number | null = null

  function applyColors(result: readonly RGB[]): void {
    if (result.length === 0 || !target) return
    const background = contrast === false ? null : nearestBackgroundColor(target)
    const clamped = background ? result.map((c) => clampToContrast(c, background, contrast as number)) : result

    if (cssVariables) {
      if (sample === 'edges') {
        target.style.setProperty('--aura-color', rgbToCss(clamped[0]!))
      } else {
        clamped.forEach((c, i) => target!.style.setProperty(`--aura-color-${i}`, rgbToCss(c)))
      }
    }

    if (glow && glowEl) {
      const [r, g, b] = clamped[0]!
      // The colour at 40% alpha, written properly. This used to append a
      // hex alpha to rgb() -- `rgb(143, 116, 178)66` -- which is invalid
      // CSS, so the browser dropped the whole background: the glow, one of
      // aura's three outputs, never rendered (happy-dom accepts any string,
      // so no test saw it).
      const stop = `rgb(${r} ${g} ${b} / 0.4) 0%, transparent 70%`
      // Spec §10: blend in OKLCH by default. Set the plain gradient first:
      // a browser without `in oklch` ignores the second assignment and
      // keeps the first, rather than losing the glow altogether.
      glowEl.style.background = `radial-gradient(circle, ${stop})`
      glowEl.style.background = `radial-gradient(in oklch circle, ${stop})`
    }

    onSample?.(clamped)
  }

  function renderFrame(timestamp: number): void {
    if (destroyed || !glContext || !plane || !downsampler) return
    if (lastSampleTime !== null && timestamp - lastSampleTime < sampleIntervalMs) return
    lastSampleTime = timestamp

    plane.upload()
    if (!plane.texture) {
      // No texture is exactly the cross-origin case: report it before
      // bailing, or the error would never be heard.
      reporter?.afterDraw(plane)
      return
    }

    const downsampled = downsampler.sample(plane.texture)
    if (!downsampled) return

    const result = sample === 'edges' ? [sampleEdges(downsampled.pixels, downsampled.width, downsampled.height)] : samplePalette(downsampled.pixels, downsampled.width, downsampled.height, colors)

    applyColors(result)
    reporter?.afterDraw(plane)
  }

  return {
    name: 'aura',
    // A fresh, identically configured copy, for comice('.many') giving every
    // matched element its own instance (see core's ComicePlugin.create).
    create: () => aura(options),

    setup(rawTarget: Element, instance: ComiceInstance) {
      if (!isUploadableSource(rawTarget)) {
        throw new Error('[comice] aura() requires an <img> or <video> target.')
      }
      target = rawTarget

      // Keyed off the REAL target — createGLContext() returns null for a
      // detached root. aura never mounts the canvas (it only reads), BUT
      // the context is shared per element: when another plugin already
      // draws on this target, this is that plugin's context and its canvas
      // is on the page. So aura must never remove the canvas on teardown
      // (it used to, blanking the other plugin — e.g. the stress page's
      // hero), and must restore GL state it changes (see downsample.ts).
      glContext = createGLContext(target)
      // ready / error lifecycle events (spec §04): ready once colours are
      // produced; error says why none will be.
      reporter = createGLReporter(instance, 'aura')
      if (!glContext) reporter.noContext()
      plane = createPlane(glContext, target)
      if (glContext) {
        downsampler = createDownsampler(glContext.gl)
      }

      if (glow) {
        glowEl = document.createElement('div')
        glowEl.style.position = 'absolute'
        glowEl.style.inset = '-20%'
        glowEl.style.zIndex = '-1'
        glowEl.style.pointerEvents = 'none'
        glowEl.style.filter = 'blur(24px)'
        glowEl.style.transition = 'background 0.3s ease-out'
        const parent = target.parentElement
        if (parent && getComputedStyle(parent).position === 'static') {
          parent.style.position = 'relative'
        }
        target.insertAdjacentElement('beforebegin', glowEl)
      }

      // Render only when visible (spec §13): off-screen, in a hidden tab, or once
      // the frame budget has dropped to a static poster (core's budget.ts), this
      // does zero work. `isConnected` alone kept every effect drawing while
      // scrolled away — particles off-screen held a whole page at 4fps.
      visibility = createVisibilityGate(target)
      unregisterFromScheduler = getSharedScheduler().add(
        (_deltaMs, timestamp) => renderFrame(timestamp),
        () => !destroyed && !!target && target.isConnected && visibility!.shouldDraw(),
      )
    },

    teardown() {
      destroyed = true
      unregisterFromScheduler?.()
      visibility?.destroy()
      visibility = null
      downsampler?.destroy()
      plane?.destroy()
      glowEl?.remove()
      if (target && cssVariables) {
        target.style.removeProperty('--aura-color')
        for (let i = 0; i < colors; i++) target.style.removeProperty(`--aura-color-${i}`)
      }
      target = null
      glContext = null
      plane = null
      downsampler = null
      glowEl = null
    },
  }
}
