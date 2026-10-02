/**
 * @comice/distort
 * ─────────────────────────────────────────────────────────────────────────────
 * Field distortion that follows an input — spec §08's own words: "The
 * cursor is a force in the field, not a shape drawn at a point." T8's
 * second half (see @comice/dissolve's own header for the full T2/T5
 * context this pass shares).
 *
 * SCOPE: `bulge`, `lens`, `glass` — see shader.ts's own header for why
 * these three. `ripple`/`smear`/`shapedLens`/`tear`/`liquid` are a
 * follow-up.
 *
 * TARGET, LIKE morph, UNLIKE dissolve: the target element IS the media —
 * `distort` styles/replaces what's already there with a WebGL2 canvas,
 * the same `visibility: hidden` + canvas-insertion pattern morph's
 * setup() established. `comice('.image').use(distort({ effect: 'glass'
 * })).driver(pointer())` (spec's own example) — the target is the image
 * being distorted, not a separate container.
 *
 * POINTER, PER SPEC'S OWN EXCLUDES: "lag is the pointer driver's
 * smoothing and the mapping layer's, never a third implementation here."
 * distort reads pointer position via instance.display.x/y — the channel
 * packages/core/src/index.ts's `.driver()` handler now routes
 * `signal.pointer` into (a real, previously-missing gap in core, fixed
 * as part of this same T8 pass specifically because distort needed it —
 * see ROADMAP.md's T8 entry). pointer()'s own `lag` option already
 * smooths the position before it ever reaches here; distort adds no
 * smoothing of its own, per spec's explicit exclusion.
 */

import type { ComiceInstance, ComicePlugin } from 'comice'
import { prefersReducedMotion } from 'comice'
import { createGLContext, createPlane, getResidencyPool, mountCanvas, type CanvasMount, type GLContext, type Plane } from 'comice/gl'
import { createVisibilityGate, getSharedScheduler } from 'comice/scheduler'
import {
  compileDistortProgram,
  destroyDistortProgram,
  drawDistort,
  type DistortEffect,
  type DistortProgram,
} from './shader.js'

export type DistortOptions = {
  /** Which distortion field. Default 'bulge'. Matches spec §08 exactly:
   *  "liquid and glass are presets over the same field, not separate
   *  engines" — 'glass' here reuses the SAME field math as 'bulge'/'lens',
   *  differing only in how the field is applied to the sampled pixels
   *  (displace vs. refract), per that same card text. */
  effect?: DistortEffect
  /** Influence radius, in the SAME normalized field-space units
   *  shader.ts's `u_radius` reads (roughly px / min(width, height) —
   *  radius 160 on a 800px-tall element is 0.2). Default 160 (px,
   *  matching spec's own stated default before normalization). */
  radius?: number
  /** Field magnitude. Default 0.5, matching spec exactly. */
  strength?: number
  /** Index-of-refraction bend, 'glass' only. Default 0, matching spec
   *  exactly ("Index-of-refraction bend, glass. Default 0."). */
  refraction?: number
  /** Edge falloff shape. Default 'smooth', matching spec exactly. */
  falloff?: 'linear' | 'smooth' | 'exp'
}

type Uploadable = HTMLImageElement | HTMLVideoElement

function isUploadableSource(target: Element): target is Uploadable {
  return target instanceof HTMLImageElement || target instanceof HTMLVideoElement
}

export function distort(options: DistortOptions = {}): ComicePlugin {
  const { effect = 'bulge', radius = 160, strength = 0.5, refraction = 0, falloff = 'smooth' } = options

  let target: Uploadable | null = null
  let glContext: GLContext | null = null
  let plane: Plane | null = null
  let distortProgram: DistortProgram | null = null
  let unsubscribe: (() => void) | null = null
  let unregisterFromScheduler: (() => void) | null = null
  let visibility: ReturnType<typeof createVisibilityGate> | null = null
  let resizeObserver: ResizeObserver | null = null
  let mount: CanvasMount | null = null
  let destroyed = false

  // pointerX/pointerY/pointerActive are read from instance.display —
  // NOT stored as mappable params the way morph's mouseX/mouseY were.
  // distort's own natural driver (pointer()) already reaches the plugin
  // through core's new signal.pointer -> setDisplay(x, y) routing, so a
  // second, plugin-owned params channel for the same data would just be
  // a redundant path to the same value — instance.on('*') is enough.
  let pointerX = 0
  let pointerY = 0
  let pointerActive = false

  function renderFrame(): void {
    if (destroyed || !glContext || !plane || !distortProgram || !target) return
    glContext.resizeToDisplay()

    const cssWidth = glContext.canvas.clientWidth || 1
    const cssHeight = glContext.canvas.clientHeight || 1
    // radius is supplied in px (matching spec's own stated default of
    // 160px) — normalized here against the smaller dimension, the same
    // convention pointer()'s own driver uses for its influence radius,
    // so a caller's radius option means the same physical distance
    // whether it ends up driving the state machine (pointer()) or this
    // shader's field (distort itself).
    const normalizedRadius = radius / Math.min(cssWidth, cssHeight)

    getResidencyPool(glContext).beginPass()
    drawDistort(glContext, distortProgram, plane, {
      pointerX,
      pointerY,
      pointerActive,
      radius: Math.max(0.001, normalizedRadius),
      strength,
      refraction,
      resolutionWidth: cssWidth,
      resolutionHeight: cssHeight,
    })
  }

  return {
    name: 'distort',

    setup(rawTarget: Element, instance: ComiceInstance) {
      if (!isUploadableSource(rawTarget)) {
        throw new Error('[comice] distort() requires an <img> or <video> target.')
      }
      target = rawTarget

      // Degrade-never-disappear: with no WebGL2, nothing is mounted and the
      // original, undistorted media stays exactly as the browser shows it.
      // mountCanvas() owns hiding the target, sizing the canvas to it, and
      // restoring both — and throws, before touching the DOM, if another
      // GL plugin already draws on this element.
      glContext = createGLContext(target)
      if (glContext) {
        mount = mountCanvas(glContext, target, { owner: 'distort', hideTarget: true })
      }

      plane = createPlane(glContext, target)

      if (glContext) {
        distortProgram = compileDistortProgram(glContext.gl, { effect, falloff })
        // A failed compile would otherwise leave the media hidden behind an
        // empty canvas; show the original instead.
        if (!distortProgram) mount?.release()
      }

      resizeObserver = new ResizeObserver(() => renderFrame())
      resizeObserver.observe(target)

      // Render only when visible (spec §13): off-screen, in a hidden tab, or once
      // the frame budget has dropped to a static poster (core's budget.ts), this
      // does zero work. `isConnected` alone kept every effect drawing while
      // scrolled away — particles off-screen held a whole page at 4fps.
      visibility = createVisibilityGate(target)
      unregisterFromScheduler = getSharedScheduler().add(
        () => renderFrame(),
        () => !destroyed && !!target && target.isConnected && visibility!.shouldDraw(),
      )

      // instance.display.x/y carries the routed pointer position (see
      // the file header) — 'entering'/'active'/'leaving'/'idle' from
      // pointer()'s own progress signal (1 inside radius, 0 outside) is
      // what pointerActive reads, not a separate hit-test of its own.
      unsubscribe = instance.on('*', (snapshot) => {
        // pointer() reports CSS px from the target's top-left, y down; the
        // shader's u_pointer is -1..1 in the quad's own space, y UP (uv
        // v=0 is the bottom). Passing px straight through put the field
        // hundreds of units off-image, so the bulge never showed — hidden
        // until pointer() could deliver events at all.
        const rect = target!.getBoundingClientRect()
        pointerX = rect.width > 0 ? (snapshot.display.x / rect.width) * 2 - 1 : 0
        pointerY = rect.height > 0 ? 1 - (snapshot.display.y / rect.height) * 2 : 0
        // A field that follows the cursor IS motion: under reduced motion it
        // stays off and the media shows undistorted.
        pointerActive = (snapshot.state === 'active' || snapshot.state === 'entering') && !prefersReducedMotion()
        renderFrame()
      })

      renderFrame()
    },

    teardown() {
      destroyed = true
      unregisterFromScheduler?.()
      visibility?.destroy()
      visibility = null
      unsubscribe?.()
      resizeObserver?.disconnect()
      if (glContext && distortProgram) destroyDistortProgram(glContext.gl, distortProgram)
      plane?.destroy()
      mount?.release()
      mount = null
      target = null
      glContext = null
      plane = null
      distortProgram = null
      resizeObserver = null
    },
  }
}

export type { DistortEffect } from './shader.js'
