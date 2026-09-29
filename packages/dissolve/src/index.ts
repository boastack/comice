/**
 * @comice/dissolve
 * ─────────────────────────────────────────────────────────────────────────────
 * Media moving from A to B — spec §08's own words: "Owns: moving between
 * two pieces of media that are both resident at once." T8 (ROADMAP.md §4),
 * the first real exercise of T2 (multi-texture residency, two genuinely
 * different sources bound in one pass) and T5 (gl/noise.ts, spliced into
 * a real shader for the first time anywhere in this codebase).
 *
 * SCOPE: three of the spec card's eleven transitions — `crossfade`,
 * `noise`, `liquid` — see shader.ts's own header for why these three.
 * `displace`/`wipe`/`zoomBlur`/`pixelBridge`/`ink`/`flip`/`glitch`/`mask`/
 * `dissolve` are a follow-up.
 *
 * HOW from/to WORK, DIFFERENT FROM morph: spec's own examples —
 * `comice('#gallery').use(dissolve({ to: images, ... }))` and
 * `comice('.hero').use(dissolve({ from: imageA, to: imageB, ... }))` —
 * make `from`/`to` explicit MEDIA OPTIONS, not the target element itself.
 * The target is where dissolve's own canvas is anchored/sized (matching
 * morph's createGLContext(target) pattern), but the actual pixels come
 * from two separately-supplied elements. Unlike morph, the target itself
 * is never hidden or used as a media source — it is purely a positioning
 * anchor. A caller typically points dissolve at an otherwise-empty
 * container element sized to the desired output box.
 */

import type { ComiceInstance, ComicePlugin } from 'comice'
import { createGLContext, createPlane, getResidencyPool, mountCanvas, type CanvasMount, type GLContext, type Plane } from 'comice/gl'
import { getSharedScheduler } from 'comice/scheduler'
import {
  compileDissolveProgram,
  destroyDissolveProgram,
  drawDissolve,
  type DissolveProgram,
  type DissolveTransition,
  type NoiseOptions,
} from './shader.js'

export type DissolveOptions = {
  /** Which transition drives the blend. Default 'crossfade'. Matches spec
   *  §08's `transition` option exactly ("Default 'crossfade'."). */
  transition?: DissolveTransition
  /** The starting media. Required. */
  from: HTMLImageElement | HTMLVideoElement
  /** The ending media. Required. Spec §08 allows `to` to be an array for
   *  a sequence — not implemented this pass (single Media only); see the
   *  file header's scope note. */
  to: HTMLImageElement | HTMLVideoElement
  /** `{ scale, intensity, softness }` for the 'noise' and 'liquid'
   *  transitions. Ignored for 'crossfade'. */
  noise?: NoiseOptions
}

export function dissolve(options: DissolveOptions): ComicePlugin {
  const { transition = 'crossfade', from, to, noise } = options

  if (!from || !to) {
    // Same "fail loudly on a programmer error" discipline every other
    // plugin's construction-time validation uses (morph's mask
    // requirement, mapping.ts's malformed-config throws) — a dissolve
    // with no real media to blend between is a configuration error, not
    // something to silently no-op.
    throw new Error("[comice] dissolve() requires both `from` and `to` media.")
  }

  let target: Element | null = null
  let glContext: GLContext | null = null
  let fromPlane: Plane | null = null
  let toPlane: Plane | null = null
  let dissolveProgram: DissolveProgram | null = null
  let unsubscribe: (() => void) | null = null
  let unregisterFromScheduler: (() => void) | null = null
  let resizeObserver: ResizeObserver | null = null
  let mount: CanvasMount | null = null
  let currentProgress = 0
  let destroyed = false

  function renderFrame(): void {
    if (destroyed || !glContext || !fromPlane || !toPlane || !dissolveProgram) return
    glContext.resizeToDisplay()

    // Both planes drawn in the SAME residency pass — this is the actual
    // point of T2: two independent textures resident and addressable
    // together, not two separate draws each starting a fresh pass.
    getResidencyPool(glContext).beginPass()
    drawDissolve(glContext, dissolveProgram, fromPlane, toPlane, { progress: currentProgress })
  }

  function render(progress: number): void {
    currentProgress = Math.max(0, Math.min(1, progress))
    renderFrame()
  }

  return {
    name: 'dissolve',

    setup(rawTarget: Element, instance: ComiceInstance) {
      target = rawTarget

      // Unlike morph, the target is never hidden or read as media — it
      // is purely a positioning/sizing anchor for dissolve's own canvas.
      // See the file header for why from/to are separate options instead.
      //
      // mountCanvas() sizes the canvas to the target's OWN box. It used to
      // be 100% of the target's parent, which on a real page covered the
      // whole section, heading and body text included (harness/site/'s
      // "Before / after" section was entirely hidden under it).
      //
      // Degrade-never-disappear: no WebGL2, or a non-HTML target (a canvas
      // can't render as a sibling inside an <svg>), mounts nothing — the
      // target was never touched, so the page shows it as it always would.
      glContext = createGLContext(target)
      if (glContext && target instanceof HTMLElement) {
        mount = mountCanvas(glContext, target, { owner: 'dissolve', hideTarget: false })
      }

      fromPlane = createPlane(glContext, from)
      toPlane = createPlane(glContext, to)

      if (glContext) {
        dissolveProgram = compileDissolveProgram(glContext.gl, { transition, noise })
      }

      resizeObserver = new ResizeObserver(() => renderFrame())
      resizeObserver.observe(target)

      // Rides getSharedScheduler() — no private rAF loop, same discipline
      // every T1+ file in this package holds to. Gated on the target's
      // own connectedness, matching morph's own gate exactly.
      unregisterFromScheduler = getSharedScheduler().add(
        () => renderFrame(),
        () => !destroyed && !!target && target.isConnected,
      )

      unsubscribe = instance.on('*', (snapshot) => {
        render(snapshot.progress)
      })

      render(instance.progress)
    },

    teardown() {
      destroyed = true
      unregisterFromScheduler?.()
      unsubscribe?.()
      resizeObserver?.disconnect()
      if (glContext && dissolveProgram) destroyDissolveProgram(glContext.gl, dissolveProgram)
      fromPlane?.destroy()
      toPlane?.destroy()
      mount?.release()
      mount = null
      target = null
      glContext = null
      fromPlane = null
      toPlane = null
      dissolveProgram = null
      resizeObserver = null
    },

    // MappableTarget: progress is dissolve's one mappable parameter,
    // matching spec §08's own card exactly: "progress: number, Mappable,
    // so any driver can scrub the transition directly."
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

export type { DissolveTransition } from './shader.js'
