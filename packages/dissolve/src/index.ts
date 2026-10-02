/**
 * @comice/dissolve
 * ─────────────────────────────────────────────────────────────────────────────
 * Media moving from A to B — spec §08's own words: "Owns: moving between
 * two pieces of media that are both resident at once." T8 (ROADMAP.md §4),
 * the first real exercise of T2 (multi-texture residency, two genuinely
 * different sources bound in one pass) and T5 (gl/noise.ts, spliced into
 * a real shader for the first time anywhere in this codebase).
 *
 * ALL TWELVE TRANSITIONS on the card: crossfade, displace, wipe, zoomBlur,
 * pixelBridge, ink, flip, glitch, noise, liquid, mask, dissolve — one GLSL
 * entry each in shader.ts.
 *
 * HOW from/to WORK, DIFFERENT FROM morph: spec's own examples —
 * `comice('#gallery').use(dissolve({ to: images, ... }))` and
 * `comice('.hero').use(dissolve({ from: imageA, to: imageB, ... }))` —
 * make `from`/`to` explicit MEDIA OPTIONS, not the target element itself.
 * The target is where dissolve's own canvas is anchored/sized, but the
 * pixels come from separately-supplied elements; the target itself is
 * never hidden or used as a media source. A caller typically points
 * dissolve at an otherwise-empty container sized to the output box.
 *
 * SEQUENCES: "to may be an array for a sequence." Progress then runs
 * through every source in order — with N sources, each neighbouring pair
 * gets 1/(N-1) of the range — and `from` may be left out (the gallery
 * example has none): the sequence starts at to[0].
 */

import type { ComiceInstance, ComicePlugin } from 'comice'
import { snapForReducedMotion } from 'comice'
import {
  createDerivedMask,
  createGLContext,
  createGLReporter,
  createPlane,
  createRasterizedMask,
  getResidencyPool,
  mountCanvas,
  type CanvasMount,
  type DerivedMask,
  type GLContext,
  type GLReporter,
  type Plane,
  type RasterizedMask,
  type RasterizedMaskSource,
} from 'comice/gl'
import { createVisibilityGate, getSharedScheduler } from 'comice/scheduler'
import { compileDissolveProgram, destroyDissolveProgram, drawDissolve, type DissolveProgram, type DissolveTransition, type NoiseOptions } from './shader.js'

type Media = HTMLImageElement | HTMLVideoElement

/** For transition 'mask': a shape, text, or another image/video read by
 *  brightness (brightest crosses first). */
export type DissolveMaskSource = RasterizedMaskSource | Media

export type DissolveOptions = {
  /** Which transition drives the blend. Default 'crossfade'. */
  transition?: DissolveTransition
  /** The starting media. Optional when `to` is a sequence (it starts at
   *  to[0]); required otherwise. */
  from?: Media
  /** The ending media — or an array, for a sequence through all of them. */
  to: Media | readonly Media[]
  /** `{ scale, intensity, direction, threshold, softness, seed }` — the
   *  noise transitions' field; `direction` also steers 'wipe'. */
  noise?: NoiseOptions
  /** URL of a displacement texture for 'displace' (red/green around 0.5
   *  push x/y). Without one, displace uses procedural noise. */
  map?: string
  /** For transition 'mask'. */
  mask?: DissolveMaskSource
}

function isMedia(value: unknown): value is Media {
  return value instanceof HTMLImageElement || value instanceof HTMLVideoElement
}

export function dissolve(options: DissolveOptions): ComicePlugin {
  const { transition = 'crossfade', from, to, noise, map, mask } = options
  const sources: Media[] = [...(from ? [from] : []), ...(Array.isArray(to) ? to : to ? [to as Media] : [])]

  if (sources.length < 2) {
    // A dissolve with nothing to move between is a configuration error,
    // not something to silently no-op.
    throw new Error('[comice] dissolve() needs two media to move between: `from` and `to`, or a `to` sequence of two or more.')
  }
  if (transition === 'mask' && !mask) {
    throw new Error("[comice] dissolve(): transition 'mask' needs a `mask` — a shape, text, an image or a video.")
  }

  let target: Element | null = null
  let glContext: GLContext | null = null
  let reporter: GLReporter | null = null
  let planes: Plane[] = []
  let mapPlane: Plane | null = null
  let maskPlane: Plane | null = null
  let rasterized: RasterizedMask | null = null
  let derived: DerivedMask | null = null
  let dissolveProgram: DissolveProgram | null = null
  let unsubscribe: (() => void) | null = null
  let unregisterFromScheduler: (() => void) | null = null
  let visibility: ReturnType<typeof createVisibilityGate> | null = null
  let resizeObserver: ResizeObserver | null = null
  let mount: CanvasMount | null = null
  let currentProgress = 0
  let destroyed = false

  function rasterizeMask(): void {
    if (!rasterized || !mask || isMedia(mask) || !(target instanceof HTMLElement)) return
    rasterized.rasterize(mask, target.clientWidth || target.offsetWidth || 1, target.clientHeight || target.offsetHeight || 1)
  }

  function renderFrame(): void {
    if (destroyed || !glContext || !dissolveProgram) return
    glContext.resizeToDisplay()
    const width = glContext.canvas.clientWidth || 1
    const height = glContext.canvas.clientHeight || 1

    // Which neighbouring pair, and how far between them: a sequence of N
    // sources splits progress into N-1 equal legs.
    const legs = planes.length - 1
    const position = currentProgress * legs
    const leg = Math.min(legs - 1, Math.floor(position))
    const legProgress = position - leg

    if (derived && maskPlane?.texture) derived.reduce(maskPlane.texture, width, height)

    // Every texture in the SAME residency pass — T2's point: independent
    // textures resident and addressable together.
    getResidencyPool(glContext).beginPass()
    drawDissolve(glContext, dissolveProgram, planes[leg]!, planes[leg + 1]!, {
      progress: legProgress,
      resolutionWidth: width,
      resolutionHeight: height,
      mapTexture: mapPlane?.texture ?? null,
      maskField: rasterized?.field ?? derived?.field ?? null,
    })
    reporter?.afterDraw(planes[leg]!, planes[leg + 1]!, ...(mapPlane ? [mapPlane] : []), ...(maskPlane ? [maskPlane] : []))
  }

  function render(progress: number): void {
    // Reduced motion: jump to whichever end state is closer, never animate between.
    currentProgress = Math.max(0, Math.min(1, snapForReducedMotion(progress)))
    renderFrame()
  }

  return {
    name: 'dissolve',

    setup(rawTarget: Element, instance: ComiceInstance) {
      target = rawTarget

      // mountCanvas() sizes the canvas to the target's OWN box (it used to
      // cover the whole parent section, heading and text included).
      // Degrade-never-disappear: no WebGL2, or a non-HTML target (a canvas
      // can't render as a sibling inside an <svg>), mounts nothing — the
      // target was never touched, so the page shows it as it always would.
      glContext = createGLContext(target)
      // ready / error lifecycle events (spec §04).
      reporter = createGLReporter(instance, 'dissolve', () => mount?.release())
      if (!glContext) reporter.noContext()
      if (glContext && target instanceof HTMLElement) {
        mount = mountCanvas(glContext, target, { owner: 'dissolve', hideTarget: false })
      }

      planes = sources.map((source) => createPlane(glContext, source))

      if (glContext) {
        if (transition === 'displace' && map) {
          const mapImage = new Image()
          mapImage.crossOrigin = 'anonymous'
          mapImage.src = map
          mapPlane = createPlane(glContext, mapImage)
        }
        if (transition === 'mask' && mask) {
          if (isMedia(mask)) {
            maskPlane = createPlane(glContext, mask)
            derived = createDerivedMask(glContext, mask instanceof HTMLVideoElement ? 'video' : 'image')
          } else {
            rasterized = createRasterizedMask(glContext)
            rasterizeMask()
          }
        }
        dissolveProgram = compileDissolveProgram(glContext.gl, { transition, noise, hasMap: !!mapPlane })
        if (!dissolveProgram) reporter.noProgram()
      }

      resizeObserver = new ResizeObserver(() => {
        rasterizeMask()
        renderFrame()
      })
      resizeObserver.observe(target)

      // Render only when visible (spec §13): off-screen, in a hidden tab, or once
      // the frame budget has dropped to a static poster (core's budget.ts), this
      // does zero work.
      visibility = createVisibilityGate(target)
      unregisterFromScheduler = getSharedScheduler().add(
        () => renderFrame(),
        () => !destroyed && !!target && target.isConnected && visibility!.shouldDraw(),
      )

      unsubscribe = instance.on('*', (snapshot) => {
        render(snapshot.progress)
      })

      render(instance.progress)
    },

    teardown() {
      destroyed = true
      unregisterFromScheduler?.()
      visibility?.destroy()
      visibility = null
      unsubscribe?.()
      resizeObserver?.disconnect()
      if (glContext && dissolveProgram) destroyDissolveProgram(glContext.gl, dissolveProgram)
      planes.forEach((plane) => plane.destroy())
      mapPlane?.destroy()
      maskPlane?.destroy()
      rasterized?.destroy()
      derived?.destroy()
      mount?.release()
      mount = null
      target = null
      glContext = null
      planes = []
      mapPlane = null
      maskPlane = null
      rasterized = null
      derived = null
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

export type { DissolveTransition, NoiseOptions } from './shader.js'
