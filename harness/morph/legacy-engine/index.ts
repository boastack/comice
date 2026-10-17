/** @comice/morph — media changing shape over signed distance fields.
 * Mounts a GPU surface over the real image/video, driven through core's
 * progress and mapping APIs. Legacy geometry is available without adding
 * Three.js or GSAP to the runtime. */

import type { ComiceInstance, ComicePlugin } from 'comice'
import { snapForReducedMotion, prefersReducedMotion } from 'comice'
import {
  createGLContext,
  createGLReporter,
  createPlane,
  createRasterizedMask,
  effectiveDPR,
  type RasterizeOptions,
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
  type MorphShaderOptions,
} from './shader.js'
import { LAYOUT_SDF_DEPENDENCIES, type LayoutName } from './layouts.js'
import { compileClipPath, type ShapeMask } from '../../../packages/morph/src/clip-path.js'
import { resolveShape, validateShape, type MorphShape } from '../../../packages/morph/src/shape-input.js'
import { validateSurface, type SurfaceOptions } from '../../../packages/morph/src/surface.js'
import type { JoinOptions } from '../../../packages/morph/src/shape-shader.js'

/** The `maxDistance` gl/mask.ts's SDF bake uses for morph's `mask`
 *  operation. Kept as one constant here (rather than a per-call option)
 *  since morph's shader.ts computes `maskScale` from this exact value at
 *  draw time — the two must always agree, and there is no benefit to a
 *  caller tuning this independently the way gl/mask.ts's own
 *  `RasterizeOptions.maxDistance` is tunable for other consumers. */
const MASK_BAKE_MAX_DISTANCE = 96

export type MorphOptions = SurfaceOptions & Pick<MorphShaderOptions, 'stagger' | 'direction' | 'maskStyle' | 'maskSize' | 'liquidSheen' | 'cursorFollow'> & {
  /** Caller-supplied destination: complete SVG URL/document/element, image or mask. */
  to?: MorphShape
  /** Caller-supplied starting silhouette. Omit to use the media's own rectangle. */
  from?: MorphShape
  /** Center connections between neighboring components of the starting SVG. */
  join?: JoinOptions | boolean
  /** SDF rasterization settings; fixed resolution is useful for art-directed masks. */
  maskRasterization?: RasterizeOptions
  /** Override the recovered SDF distance in shader coordinates. Normally derived from the bake height. */
  maskDistance?: number
  /** Which of the five legacy operations to perform. Optional with `to`,
   *  which uses the caller-supplied SVG transition. */
  operation?: MorphOperation
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
  thread?: ThreadOptions | false
  /** The order the pieces move in: 'sequence' (default) one after another,
   *  'alternate' dealt either side of the centre. Spec §08. */
  order?: MorphOrder
}

type Uploadable = HTMLImageElement | HTMLVideoElement

function isUploadableSource(target: Element): target is Uploadable {
  return target instanceof HTMLImageElement || target instanceof HTMLVideoElement
}

export function legacyMorph(options: MorphOptions): ComicePlugin {
  const {
    layout = 'shelf',
    liquid = 0.5,
    count,
    recomposeTarget = 'frame',
    recomposeStart = 0.85,
    recomposeEnd = 1.0,
    thread: requestedThread,
    order = 'sequence',
  } = options
  const operation = options.operation ?? (options.to !== undefined ? 'mask' : undefined)
  const thread = requestedThread || undefined
  validateSurface(options)
  if (options.to !== undefined) validateShape(options.to)
  if (options.from !== undefined) {
    if (options.to === undefined) throw new Error('[comice] A starting shape needs a destination in `to`.')
    validateShape(options.from)
  }
  if (options.join) {
    if (options.to === undefined || options.from === undefined) throw new Error('[comice] Center joins need caller-supplied `from` and `to` shapes.')
    const join = options.join === true ? {} : options.join
    if (join.style !== undefined && !['metaball', 'slab'].includes(join.style)) throw new Error('[comice] Join style must be metaball or slab.')
    if (join.points && (join.points.length < 2 || join.points.length > 32 || join.points.some((p) => p.length !== 2 || p.some((v) => !Number.isFinite(v) || v < 0 || v > 1)))) throw new RangeError('[comice] Join points must contain 2–32 normalized [x, y] centers.')
    for (const value of [join.width, join.pinch, join.sag, join.fillet]) if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new RangeError('[comice] Join settings must be finite and nonnegative.')
    if ((join.pinch ?? .35) > 1) throw new RangeError('[comice] Join pinch must be in [0, 1].')
  }

  if (options.into === 'svg' && !options.path) {
    throw new Error("[comice] morph({ into: 'svg' }) needs a `path`.")
  }
  if (options.into === 'text' && !options.text) {
    throw new Error("[comice] morph({ into: 'text' }) needs a `text`.")
  }
  let mask: ShapeMask | undefined =
    options.into === 'svg'
      ? { type: 'shape', path: options.path!, viewBox: options.viewBox }
      : options.into === 'text'
        ? { type: 'text', text: options.text! }
        : options.mask

  const usesMask = options.to !== undefined || operation === 'mask' || (operation === 'recompose' && recomposeTarget === 'mask')
  if (usesMask && !mask && options.to === undefined) {
    // Same "fail loudly on a programmer error" discipline setup()'s
    // target-type check uses below — operation: 'mask' with no mask
    // source is a configuration error, not something to silently no-op.
    throw new Error("[comice] morph({ operation: 'mask' }) needs a shape to morph into: `into: 'svg', path` (or `into: 'text', text`).")
  }

  if (!operation || !['merge', 'breakout', 'distribute', 'mask', 'recompose'].includes(operation)) throw new Error('[comice] Unknown morph operation.')
  if (!(layout in LAYOUT_SDF_DEPENDENCIES)) throw new Error(`[comice] Unknown morph layout: ${layout}.`)
  if (!['sequence', 'alternate'].includes(order)) throw new Error('[comice] Unknown morph order.')
  if (options.direction && !['forward', 'reverse'].includes(options.direction)) throw new Error('[comice] Unknown morph direction.')
  if (options.maskStyle && !['linear', 'contour', 'liquid'].includes(options.maskStyle)) throw new Error('[comice] Unknown morph maskStyle.')
  if (!['frame', 'circle', 'square', 'mask'].includes(recomposeTarget)) throw new Error('[comice] Unknown morph recomposeTarget.')
  for (const [name, value] of Object.entries({ liquid, count, recomposeStart, recomposeEnd, stagger: options.stagger, maskSize: options.maskSize, liquidSheen: options.liquidSheen, maskDistance: options.maskDistance, ...thread })) {
    if (value !== undefined && !Number.isFinite(value)) throw new RangeError(`[comice] morph ${name} must be finite.`)
  }
  if (options.stagger !== undefined && (options.stagger < 0 || options.stagger >= 1)) throw new RangeError('[comice] morph stagger must be in [0, 1).')
  if (recomposeStart < 0 || recomposeEnd > 1 || recomposeStart >= recomposeEnd) throw new RangeError('[comice] morph recomposeStart must be below recomposeEnd in [0, 1].')
  if (options.maskStyle === 'liquid' && thread) throw new Error('[comice] Liquid mask deformation does not support threads.')

  if (options.maskSize !== undefined && options.maskSize <= 0) throw new RangeError('[comice] morph maskSize must be positive.')
  if (options.maskDistance !== undefined && options.maskDistance <= 0) throw new RangeError('[comice] morph maskDistance must be positive.')
  if (options.maskRasterization?.sdf === false) throw new Error('[comice] Morph requires a signed distance mask (sdf: true).')

  let target: Uploadable | null = null
  let glContext: GLContext | null = null
  let reporter: GLReporter | null = null
  let plane: Plane | null = null
  let morphProgram: MorphProgram | null = null
  let rasterizedMask: RasterizedMask | null = null
  let fromRasterizedMask: RasterizedMask | null = null
  let fromSource: ShapeMask | undefined
  const shapeAbort = new AbortController()
  const shapeReleases: Array<() => void> = []
  let maskScale = 0.345 // legacy's own appleLogo constant, replaced once the real bake size is known
  let unsubscribe: (() => void) | null = null
  let unregisterFromScheduler: (() => void) | null = null
  let visibility: ReturnType<typeof createVisibilityGate> | null = null
  let resizeObserver: ResizeObserver | null = null
  let mount: CanvasMount | null = null
  let requestedProgress = 0
  let currentProgress = 0
  let painted = false
  let destroyed = false
  let contextLost: (() => void) | null = null
  let lastBake = ''
  const resolvedJoin: JoinOptions | false = options.join === true ? {} : options.join || false
  const automaticJoins = !!resolvedJoin && !resolvedJoin.points
  const joinPoints = new Float32Array(64)
  let joinCount = 0

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
    const rasterOptions: RasterizeOptions & { maxDistance: number } = { sdf: true, maxDistance: MASK_BAKE_MAX_DISTANCE, ...(options.to !== undefined ? { fill: 1, precision: 'half' as const } : {}), ...options.maskRasterization }
    if (options.to !== undefined && !rasterOptions.resolution) {
      const scale = Math.min(effectiveDPR(), 1024 / Math.max(cssWidth, cssHeight))
      rasterOptions.resolution = [Math.max(1, Math.round(cssWidth * scale)), Math.max(1, Math.round(cssHeight * scale))]
    }
    const bakeHeightTexels = rasterOptions.resolution?.[1] ?? Math.max(1, Math.round(cssHeight * effectiveDPR()))
    const bakeWidthTexels = rasterOptions.resolution?.[0] ?? Math.max(1, Math.round(cssWidth * effectiveDPR()))
    if (options.to !== undefined && options.maskRasterization?.maxDistance === undefined) rasterOptions.maxDistance = Math.max(bakeWidthTexels, bakeHeightTexels)
    const bakeKey = `${bakeWidthTexels}:${bakeHeightTexels}`
    if (bakeKey === lastBake) return
    rasterizedMask.rasterize(typeof mask === 'function' ? mask(cssWidth, cssHeight) : mask, cssWidth, cssHeight, rasterOptions)
    if (fromSource) fromRasterizedMask?.rasterize(typeof fromSource === 'function' ? fromSource(cssWidth, cssHeight) : fromSource, cssWidth, cssHeight, { ...rasterOptions, components: automaticJoins })
    if (resolvedJoin) {
      const points = automaticJoins ? fromRasterizedMask?.components ?? [] : resolvedJoin.points ?? []
      joinCount = points.length
      points.forEach(([x, y], i) => { joinPoints[i * 2] = x; joinPoints[i * 2 + 1] = y })
    }
    lastBake = bakeKey
    // maskScale converts the bake's texel-space distance into this
    // shader's own aspect-normalized st space — see shader.ts's
    // u_maskScale doc comment. One st-unit of vertical span corresponds
    // to the bake's full height in texels (v_uv's 0..1 vertical range
    // maps to st's -0.5..0.5, a span of 1.0), so maxDistance texels is
    // maxDistance / bakeHeightInTexels st-units — computed from the REAL
    // bake dimensions here, never a hand-tuned constant like legacy's own
    // single-shape 0.345.
    maskScale = options.maskDistance ?? rasterOptions.maxDistance / bakeHeightTexels
  }

  function renderFrame(force = false): void {
    if (destroyed || !glContext || !plane || !morphProgram || !target) return
    if (plane.error) { reporter?.afterDraw(plane); return }
    if (visibility && !(visibility.shouldDraw() || ((force || !painted) && visibility.isVisible()))) return
    currentProgress = snapForReducedMotion(requestedProgress)
    const reduced = prefersReducedMotion()
    glContext.resizeToDisplay()
    if (usesMask) rasterizeMaskIfNeeded(glContext.canvas.clientWidth, glContext.canvas.clientHeight)
    glContext.gl.clearColor(0, 0, 0, 0)
    glContext.gl.clear(glContext.gl.COLOR_BUFFER_BIT)

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
      mouseX: reduced ? 0 : mouseX,
      mouseY: reduced ? 0 : mouseY,
      velocity: reduced ? 0 : velocity,
      mediaAspect,
      resolutionWidth: glContext.canvas.clientWidth || 1,
      resolutionHeight: glContext.canvas.clientHeight || 1,
      maskTexture: rasterizedMask?.field?.kind === 'texture' ? rasterizedMask.field.texture : null,
      maskScale,
      fromMaskTexture: fromRasterizedMask?.field?.kind === 'texture' ? fromRasterizedMask.field.texture : null,
      fromScale: maskScale,
      sourceRadius: parseFloat(getComputedStyle(target).borderTopLeftRadius) || 0,
      joinPoints,
      joinCount,
    })
    painted = !!plane.texture && (!usesMask || !!rasterizedMask?.field) && (!fromSource || !!fromRasterizedMask?.field)
    if (painted) reporter?.afterDraw(plane)
  }

  function render(progress: number): void {
    // Reduced motion: jump to whichever end state is closer, never animate between.
    if (!Number.isFinite(progress)) return
    requestedProgress = Math.max(0, Math.min(1, progress))
    currentProgress = snapForReducedMotion(requestedProgress)
    renderFrame(true)
  }

  const plugin: ComicePlugin = {
    name: 'morph',
    // A fresh, identically configured copy, for comice('.many') giving every
    // matched element its own instance (see core's ComicePlugin.create).
    create: () => legacyMorph(options),

    setup(rawTarget: Element, instance: ComiceInstance) {
      if (!isUploadableSource(rawTarget)) {
        // Same "fail loudly on a programmer error" discipline reveal's
        // own setup() uses — morph needs an actual media element to
        // sample as u_media, an arbitrary Element has nothing to upload.
        throw new Error('[comice] morph() requires an <img> or <video> target.')
      }
      if (target || destroyed) throw new Error('[comice] A morph plugin instance can only be attached once; use create() for a fresh copy.')
      target = rawTarget
      requestedProgress = instance.progress
      // Same instance.on('*') pattern reveal's setup() uses — progress
      // arrives from whatever driver is attached, morph has no opinion on
      // which one; .transition()/.setProgress() work identically to how
      // reveal consumes them.
      unsubscribe = instance.on('progress', (snapshot) => {
        render(snapshot.progress)
      })

      const offState = instance.on('*', (snapshot, event) => {
        if (['idle', 'entering', 'active', 'leaving'].includes(event.type)) render(snapshot.progress)
      })
      const offProgress = unsubscribe
      unsubscribe = () => { offProgress?.(); offState() }
      const initialize = () => {
        if (destroyed || !target) return

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
          try { mount = mountCanvas(glContext, target, { owner: 'morph', hideTarget: true }) }
          catch (error) { glContext = null; target = null; throw error }
          const canvas = glContext.canvas
          const lost = () => {
            mount?.release()
            instance.fail('morph', new Error('[comice] morph(): WebGL context was lost. The original media is shown.'))
            morphProgram = null
          }
          canvas.addEventListener('webglcontextlost', lost)
          contextLost = () => canvas.removeEventListener('webglcontextlost', lost)
        }

        plane = createPlane(glContext, target)

        if (usesMask) {
          // Same degrade shape as plane/morphProgram above: createRasterizedMask(null)
          // returns a producer whose .field stays permanently null and whose
          // rasterize() is a no-op, so no extra branch is needed here for
          // the no-WebGL2 case — renderFrame()'s own null-check on maskTexture
          // already covers it.
          rasterizedMask = createRasterizedMask(glContext)
          if (fromSource) fromRasterizedMask = createRasterizedMask(glContext)
          const rect = target.getBoundingClientRect()
          rasterizeMaskIfNeeded(rect.width, rect.height)
        }

        if (glContext) {
          morphProgram = compileMorphProgram(glContext.gl, {
            ...options,
            join: resolvedJoin,
            layout,
            operation: options.to !== undefined ? 'mask' : operation,
            shapeTransition: options.to !== undefined,
            hasFromMask: options.from !== undefined,
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

        resizeObserver = new ResizeObserver(() => {
          if (usesMask && target) {
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
          () => !destroyed && !!target && target.isConnected && (visibility!.shouldDraw() || (!painted && visibility!.isVisible())),
        )

        render(requestedProgress)
      }
      if (options.to === undefined) initialize()
      else {
        // Keep the original media visible while URL/SVG inputs load. Progress
        // mappings can already write their requested value during this wait.
        const load = (shape: MorphShape) => resolveShape(shape, shapeAbort.signal).then((resolved) => {
          if (destroyed) { resolved.release(); throw new DOMException('Shape load aborted.', 'AbortError') }
          shapeReleases.push(resolved.release)
          return resolved
        })
        Promise.all([load(options.to), options.from !== undefined ? load(options.from) : Promise.resolve(undefined)]).then(([destination, source]) => {
          if (destroyed) return
          mask = destination!.mask
          fromSource = source?.mask
          initialize()
        }).catch((error) => {
          if (destroyed) return
          plugin.teardown?.()
          instance.fail('morph', error instanceof Error ? error : new Error(String(error)))
        })
      }
    },

    teardown() {
      destroyed = true
      shapeAbort.abort()
      shapeReleases.splice(0).forEach((release) => release())
      unregisterFromScheduler?.()
      visibility?.destroy()
      visibility = null
      unsubscribe?.()
      resizeObserver?.disconnect()
      contextLost?.()
      if (glContext && morphProgram) destroyMorphProgram(glContext.gl, morphProgram)
      plane?.destroy()
      rasterizedMask?.destroy()
      fromRasterizedMask?.destroy()
      mount?.release()
      mount = null
      glContext?.destroy()
      target = null
      glContext = null
      plane = null
      morphProgram = null
      rasterizedMask = null
      fromRasterizedMask = null
      mask = undefined
      fromSource = undefined
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
        if (!Number.isFinite(value) || destroyed) return
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
  return plugin
}

export type { MorphOperation, MorphOrder } from './shader.js'
export type { LayoutName } from './layouts.js'
export type { MorphShape } from '../../../packages/morph/src/shape-input.js'
export type { JoinOptions } from '../../../packages/morph/src/shape-shader.js'
export type { GlassOptions, OutlineOptions } from '../../../packages/morph/src/surface.js'
