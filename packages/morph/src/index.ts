/**
 * @comice/morph
 * ─────────────────────────────────────────────────────────────────────────────
 * Media changing shape — spec section 08's five operations over signed
 * distance fields, with liquid blending. The first SHADER plugin (T7, per
 * ROADMAP.md) — where `reveal` proved the ComicePlugin contract against CSS
 * state, this proves it against real GPU state: a live WebGL2 texture,
 * uniforms updated every frame, a program compiled from generated GLSL.
 *
 * SCOPE: all five spec operations are implemented — `merge`, `breakout`,
 * `distribute`, `mask` (T7 + follow-up — see shader.ts's header for the
 * full reasoning and the exact math ported from legacy's `appleLogo`
 * layout and `legacy/african.html`'s whole 17-shape catalogue, generalized
 * to an arbitrary caller-supplied shape) and `recompose` (a second
 * follow-up — legacy's `dFinalShape`/`pFinal` blend, verbatim). `thread`
 * (spec §08's stretching-bridge option) is ALSO implemented — see
 * thread.ts's own header: unlike everything else in this package, it has
 * no legacy reference at all, real new GLSL designed from the spec's own
 * description of "the connecting tissue stretches and visibly snaps."
 *
 * HOW THE TARGET ELEMENT WORKS: unlike `reveal` (which styles its target
 * element directly with CSS), `morph` needs a WebGL2 canvas — so the
 * target `<img>`/`<video>` becomes the shader's MEDIA SOURCE, not the
 * element being visually styled. setup() creates a canvas positioned
 * exactly over the target (via gl/context.ts's createGLContext, appended
 * here since createGLContext deliberately leaves DOM insertion to its
 * caller) and hides the original element with `visibility: hidden` (not
 * `display: none`, which would stop a <video> from decoding frames) —
 * matching legacy's own `.media-source { display: none }` pattern
 * conceptually, adapted since legacy's video elements were separate,
 * always-hidden source-only elements and Comice's contract instead wraps
 * the real, page-visible media element directly.
 */

import type { ComiceInstance, ComicePlugin } from 'comice'
import { snapForReducedMotion } from 'comice'
import {
  createGLContext,
  createGLReporter,
  createPlane,
  createRasterizedMask,
  getResidencyPool,
  mountCanvas,
  type CanvasMount,
  type GLContext,
  type GLReporter,
  type Plane,
  type RasterizedMask,
  type RasterizedMaskSource,
} from 'comice/gl'
import { createVisibilityGate, getSharedScheduler } from 'comice/scheduler'
import {
  compileMorphProgram,
  destroyMorphProgram,
  drawMorph,
  type MorphOperation,
  type MorphOrder,
  type MorphProgram,
  type RecomposeTarget,
  type ThreadOptions,
} from './shader.js'
import type { LayoutName } from './layouts.js'

/** The `maxDistance` gl/mask.ts's SDF bake uses for morph's `mask`
 *  operation. Kept as one constant here (rather than a per-call option)
 *  since morph's shader.ts computes `maskScale` from this exact value at
 *  draw time — the two must always agree, and there is no benefit to a
 *  caller tuning this independently the way gl/mask.ts's own
 *  `RasterizeOptions.maxDistance` is tunable for other consumers. */
const MASK_BAKE_MAX_DISTANCE = 96

export type MorphOptions = {
  /** Which of the five spec operations this instance performs. Required —
   *  matches spec §08's `operation` option, "Required." on the real card.
   *  All five are implemented. */
  operation: MorphOperation
  /** Which concrete target arrangement to morph toward/from. Ignored
   *  (and not required) when `operation` is 'mask'. Required for
   *  merge/breakout/distribute/recompose. 'shelf' is N evenly-spaced
   *  cards (legacy's cardDeck-style layout); the others mirror legacy's
   *  remaining layouts 1:1 — see layouts.ts. Default 'shelf'. */
  layout?: LayoutName
  /** For 'mask': what the media morphs into, in the spec's own words —
   *  `into: 'svg', path: 'M12 2L2 7…'`, or `into: 'text', text: 'ACME'`.
   *  The shape is fitted to the media (centred, by the path's own bounds or
   *  `viewBox`). */
  into?: 'svg' | 'text'
  /** The SVG path data for `into: 'svg'`. */
  path?: string
  /** The path's coordinate box `[x, y, width, height]`, e.g. `[0, 0, 24,
   *  24]` for an icon; measured from the path when left out. */
  viewBox?: readonly [number, number, number, number]
  /** The text for `into: 'text'`. */
  text?: string
  /** The same thing as `into`, in core's mask vocabulary: `{ type:
   *  'shape', path }` or `{ type: 'text', text }`. */
  mask?: RasterizedMaskSource
  /** smin blend amount, 0 to 1, matching spec §08's `liquid` option
   *  exactly. Default 0.5. */
  liquid?: number
  /** Number of distribute targets for layouts with a variable count
   *  (currently: 'shelf'). Clamped to [2, 7]. Ignored for 'mask'. */
  count?: number
  /** Required when `operation` is 'recompose', ignored otherwise. Which
   *  fixed shape the distribute arrangement settles into — legacy's
   *  `finalShape` option (its 'wordmark' case is `mask`'s job here, not
   *  recompose's — see shader.ts's file header for why). Default 'frame'. */
  recomposeTarget?: RecomposeTarget
  /** Only meaningful for `operation: 'recompose'`. Where in the 0..1
   *  progress range the settle-into-`recomposeTarget` blend starts —
   *  legacy's `finalBlendStart`. Default 0.85, matching legacy exactly. */
  recomposeStart?: number
  /** Only meaningful for `operation: 'recompose'`. Legacy's
   *  `finalBlendEnd`. Default 1.0, matching legacy exactly. */
  recomposeEnd?: number
  /** Spec §08's `{ width, pinch, sag, dissolve }` (px; pinch 0..1) — a
   *  stretching, sagging bridge that tears and snaps: between each piece
   *  and the point it merges toward, or for 'mask', holding drops at the
   *  frame's corners to the shape it collapses into. Omitted (the
   *  default) means no thread — see shader.ts/thread.ts. */
  thread?: ThreadOptions
  /** The order the pieces move in: 'sequence' (default) one after another,
   *  'alternate' dealt either side of the centre. Spec §08. */
  order?: MorphOrder
}

type Uploadable = HTMLImageElement | HTMLVideoElement

function isUploadableSource(target: Element): target is Uploadable {
  return target instanceof HTMLImageElement || target instanceof HTMLVideoElement
}

export function morph(options: MorphOptions): ComicePlugin {
  const {
    operation,
    layout = 'shelf',
    liquid = 0.5,
    count,
    recomposeTarget = 'frame',
    recomposeStart = 0.85,
    recomposeEnd = 1.0,
    thread,
    order = 'sequence',
  } = options

  if (options.into === 'svg' && !options.path) {
    throw new Error("[comice] morph({ into: 'svg' }) needs a `path`.")
  }
  if (options.into === 'text' && !options.text) {
    throw new Error("[comice] morph({ into: 'text' }) needs a `text`.")
  }
  const mask: RasterizedMaskSource | undefined =
    options.into === 'svg'
      ? { type: 'shape', path: options.path!, viewBox: options.viewBox }
      : options.into === 'text'
        ? { type: 'text', text: options.text! }
        : options.mask

  if (operation === 'mask' && !mask) {
    // Same "fail loudly on a programmer error" discipline setup()'s
    // target-type check uses below — operation: 'mask' with no mask
    // source is a configuration error, not something to silently no-op.
    throw new Error("[comice] morph({ operation: 'mask' }) needs a shape to morph into: `into: 'svg', path` (or `into: 'text', text`).")
  }

  let target: Uploadable | null = null
  let glContext: GLContext | null = null
  let reporter: GLReporter | null = null
  let plane: Plane | null = null
  let morphProgram: MorphProgram | null = null
  let rasterizedMask: RasterizedMask | null = null
  let maskScale = 0.345 // legacy's own appleLogo constant, replaced once the real bake size is known
  let unsubscribe: (() => void) | null = null
  let unregisterFromScheduler: (() => void) | null = null
  let visibility: ReturnType<typeof createVisibilityGate> | null = null
  let resizeObserver: ResizeObserver | null = null
  let mount: CanvasMount | null = null
  let currentProgress = 0
  let destroyed = false

  // Mouse/velocity are legacy's own u_mouse/u_velocity uniforms — kept as
  // live-settable state here rather than wired to a specific driver, since
  // spec §08's morph card takes no cursor-follow/velocity option of its
  // own; a consumer wanting that behavior drives it via .map() against
  // this plugin's params (see the MappableTarget block below), the same
  // Driver -> Signal -> Mapping -> Plugin Parameter path every other
  // driven plugin uses, rather than morph hardcoding a pointer dependency.
  let mouseX = 0
  let mouseY = 0
  let velocity = 0

  function rasterizeMaskIfNeeded(cssWidth: number, cssHeight: number): void {
    if (!rasterizedMask || !mask || cssWidth <= 0 || cssHeight <= 0) return
    rasterizedMask.rasterize(mask, cssWidth, cssHeight, { sdf: true, maxDistance: MASK_BAKE_MAX_DISTANCE })
    // maskScale converts the bake's texel-space distance into this
    // shader's own aspect-normalized st space — see shader.ts's
    // u_maskScale doc comment. One st-unit of vertical span corresponds
    // to the bake's full height in texels (v_uv's 0..1 vertical range
    // maps to st's -0.5..0.5, a span of 1.0), so maxDistance texels is
    // maxDistance / bakeHeightInTexels st-units — computed from the REAL
    // bake dimensions here, never a hand-tuned constant like legacy's own
    // single-shape 0.345.
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
    const bakeHeightTexels = Math.max(1, Math.round(cssHeight * Math.min(dpr, 2)))
    maskScale = MASK_BAKE_MAX_DISTANCE / bakeHeightTexels
  }

  function renderFrame(): void {
    if (destroyed || !glContext || !plane || !morphProgram || !target) return
    glContext.resizeToDisplay()

    const naturalWidth = target instanceof HTMLVideoElement ? target.videoWidth : target.naturalWidth
    const naturalHeight = target instanceof HTMLVideoElement ? target.videoHeight : target.naturalHeight
    const mediaAspect = naturalHeight > 0 ? naturalWidth / naturalHeight : 16 / 9

    // drawMorph() deliberately does not call beginPass() itself (see its
    // own doc comment) — this instance draws exactly one morph pass per
    // frame, nothing else composited alongside it, so it owns starting
    // that pass here rather than assuming some other caller already did.
    getResidencyPool(glContext).beginPass()
    drawMorph(glContext, morphProgram, plane, {
      progress: currentProgress,
      mouseX,
      mouseY,
      velocity,
      mediaAspect,
      resolutionWidth: glContext.canvas.clientWidth || 1,
      resolutionHeight: glContext.canvas.clientHeight || 1,
      maskTexture: rasterizedMask?.field?.kind === 'texture' ? rasterizedMask.field.texture : null,
      maskScale,
    })
    reporter?.afterDraw(plane)
  }

  function render(progress: number): void {
    // Reduced motion: jump to whichever end state is closer, never animate between.
    currentProgress = Math.max(0, Math.min(1, snapForReducedMotion(progress)))
    renderFrame()
  }

  return {
    name: 'morph',
    // A fresh, identically configured copy, for comice('.many') giving every
    // matched element its own instance (see core's ComicePlugin.create).
    create: () => morph(options),

    setup(rawTarget: Element, instance: ComiceInstance) {
      if (!isUploadableSource(rawTarget)) {
        // Same "fail loudly on a programmer error" discipline reveal's
        // own setup() uses — morph needs an actual media element to
        // sample as u_media, an arbitrary Element has nothing to upload.
        throw new Error('[comice] morph() requires an <img> or <video> target.')
      }
      target = rawTarget

      // The target keeps decoding/playing (a <video> needs to keep
      // rendering frames to its own backing store for texImage2D to read
      // anything meaningful) but is not itself painted by the browser —
      // the canvas below is what actually appears. visibility: hidden,
      // never display: none, for exactly that reason. mountCanvas() does
      // the hiding, sizes the canvas to the target's own box, restores both
      // on release, and refuses a second GL effect on the same element.
      //
      // Degrade-never-disappear: a null glContext (no WebGL2) mounts
      // nothing, so the original media stays painted by the browser — an
      // SDF/liquid shader has no CSS equivalent to fall back to, and the
      // untouched media beats a blank space.
      glContext = createGLContext(target)
      // ready / error lifecycle events (spec §04): say why an effect isn't
      // showing instead of degrading silently.
      reporter = createGLReporter(instance, 'morph', () => mount?.release())
      if (!glContext) reporter.noContext()
      if (glContext) {
        mount = mountCanvas(glContext, target, { owner: 'morph', hideTarget: true })
      }

      plane = createPlane(glContext, target)

      if (glContext) {
        morphProgram = compileMorphProgram(glContext.gl, {
          layout,
          operation,
          liquid,
          count,
          recomposeTarget,
          recomposeStart,
          recomposeEnd,
          thread,
          order,
        })
        // A failed compile would otherwise leave the media hidden behind an
        // empty canvas; show the original instead.
        if (!morphProgram) {
          mount?.release()
          reporter.noProgram()
        }
      }

      if (operation === 'mask') {
        // Same degrade shape as plane/morphProgram above: createRasterizedMask(null)
        // returns a producer whose .field stays permanently null and whose
        // rasterize() is a no-op, so no extra branch is needed here for
        // the no-WebGL2 case — renderFrame()'s own null-check on maskTexture
        // already covers it.
        rasterizedMask = createRasterizedMask(glContext)
        const rect = target.getBoundingClientRect()
        rasterizeMaskIfNeeded(rect.width, rect.height)
      }

      resizeObserver = new ResizeObserver(() => {
        if (operation === 'mask' && target) {
          const rect = target.getBoundingClientRect()
          rasterizeMaskIfNeeded(rect.width, rect.height)
        }
        renderFrame()
      })
      resizeObserver.observe(target)

      // Rides getSharedScheduler() rather than a private rAF loop — same
      // discipline every T1-T6 file holds to. Gated on the target's own
      // connectedness so a removed element's morph instance stops
      // rendering rather than ticking forever.
      // Render only when visible (spec §13): off-screen, in a hidden tab, or once
      // the frame budget has dropped to a static poster (core's budget.ts), this
      // does zero work. `isConnected` alone kept every effect drawing while
      // scrolled away — particles off-screen held a whole page at 4fps.
      visibility = createVisibilityGate(target)
      unregisterFromScheduler = getSharedScheduler().add(
        () => renderFrame(),
        () => !destroyed && !!target && target.isConnected && visibility!.shouldDraw(),
      )

      // Same instance.on('*') pattern reveal's setup() uses — progress
      // arrives from whatever driver is attached, morph has no opinion on
      // which one; .transition()/.setProgress() work identically to how
      // reveal consumes them.
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
      if (glContext && morphProgram) destroyMorphProgram(glContext.gl, morphProgram)
      plane?.destroy()
      rasterizedMask?.destroy()
      mount?.release()
      mount = null
      target = null
      glContext = null
      plane = null
      morphProgram = null
      rasterizedMask = null
      resizeObserver = null
    },

    // MappableTarget: progress, mouseX/mouseY and velocity are all
    // independently mappable, matching legacy's own u_progress/u_mouse/
    // u_velocity uniforms — a consumer can drive morph's progress off
    // scroll while separately mapping pointer() to mouseX/mouseY for the
    // cursor-follow parallax legacy's enableCursorFollow provided, without
    // morph hardcoding that pairing itself.
    params: {
      getParam(name: string): number {
        if (name === 'progress') return currentProgress
        if (name === 'mouseX') return mouseX
        if (name === 'mouseY') return mouseY
        if (name === 'velocity') return velocity
        return 0
      },
      setParam(name: string, value: number): void {
        if (name === 'progress') {
          render(value)
          return
        }
        if (name === 'mouseX') {
          mouseX = value
          return
        }
        if (name === 'mouseY') {
          mouseY = value
          return
        }
        if (name === 'velocity') {
          velocity = value
          return
        }
      },
    },
  }
}

export type { MorphOperation, MorphOrder } from './shader.js'
export type { LayoutName } from './layouts.js'
