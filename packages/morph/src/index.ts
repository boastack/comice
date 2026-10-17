/** @comice/morph — media changing shape over signed distance fields.
 * Mounts a GPU surface over the real image/video, driven through core's
 * progress and mapping APIs. Geometry comes from caller-supplied SVG, CSS clip-path, or text masks. */

import type { ComiceInstance, ComicePlugin } from 'comice'
import { snapForReducedMotion, prefersReducedMotion, pointer } from 'comice'
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
} from 'comice/gl'
import { createVisibilityGate, getSharedScheduler } from 'comice/scheduler'
import {
  abandonMorphProgram,
  beginMorphProgram,
  destroyMorphProgram,
  drawMorph,
  finishMorphProgram,
  morphProgramReady,
  type MorphProgram,
  type PendingMorphProgram,
} from './shape-program.js'
import { compileClipPath, radiusPair, type ShapeMask } from './clip-path.js'
import { resolveShape, validateShape, type MorphShape } from './shape-input.js'
import { validateSurface, type SurfaceOptions } from './surface.js'
import { trackWindowInput, type WindowInput } from './window-input.js'
import type { JoinOptions } from './shape-shader.js'

// How long the canvas takes to fade in over the media, and then how long the cursor-follow zoom
// takes to ease in after that.
const HANDOFF_MS = 280
const FOLLOW_EASE_MS = 900

// Default distance range; the generic bake expands it to the full mask size.
const MASK_BAKE_MAX_DISTANCE = 96

export type InteractionOptions = {
  /** Pointer influence radius, CSS px. Default 160. */
  radius?: number
  /** Local joining softness, CSS px. Default 18. */
  softness?: number
  /** Pointer wake amplitude, CSS px. Default 3. */
  wake?: number
  /** Wake retention per 60 Hz frame, in [0,1). Default .94. */
  decay?: number
}

export type MorphOptions = SurfaceOptions & {
  /** Where the media ends up: SVG URL/markup/element or CSS clip-path. Multi-part
   *  geometry and holes are preserved. Omit it and the end is the media's own
   *  frame: its CSS `clip-path`, or its box with the `border-radius` you set on it. */
  to?: MorphShape
  /** Where the media starts, same inputs. Omit it and the start is the media's own
   *  frame (its CSS `clip-path`, or its box with its `border-radius`). */
  from?: MorphShape
  /** Automatic midpoint joins/separation, or caller-supplied centers. Default off. */
  join?: JoinOptions | boolean
  direction?: 'forward' | 'reverse'
  liquid?: number
  liquidSheen?: number
  /** Media parallax driven by `mouseX`/`mouseY`, default on. `{ offset, zoom }`
   *  sets how far the media follows the pointer (fraction of its size, default
   *  .035) and how far it is zoomed in so the offset never shows an edge
   *  (default .95, a 5% margin). It holds through the whole motion, not only
   *  mid-way. It follows the pointer over the whole page by itself (eased as the
   *  legacy pages did, on devices with a hover-capable pointer); mapping or setting
   *  `mouseX` / `mouseY` yourself takes over. `false` turns it off, with no zoom. */
  cursorFollow?: boolean | { offset?: number; zoom?: number }
  /** Bends the shape with `velocity`, an arch across its width and a pinch
   *  along its height, so it flexes as the page scrolls. `true` or
   *  `{ x, y }` (fraction of the media, default .014 and .028); default off.
   *  It follows how fast the page is scrolling by itself; mapping or setting
   *  `velocity` yourself (an audio signal, say) takes over. */
  bend?: boolean | { x?: number; y?: number }
  /** Native core pointer interaction; independent of progress. Default off. */
  interaction?: InteractionOptions | boolean
  maskRasterization?: RasterizeOptions
}

type Uploadable = HTMLImageElement | HTMLVideoElement

function isUploadableSource(target: Element): target is Uploadable {
  return target instanceof HTMLImageElement || target instanceof HTMLVideoElement
}

export function morph(options: MorphOptions): ComicePlugin {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('[comice] morph() needs an options object.')
  const liquid = options.liquid ?? .5
  validateSurface(options)
  if (options.to !== undefined) validateShape(options.to)
  if (options.from !== undefined) validateShape(options.from)
  for (const key of ['join', 'cursorFollow', 'bend'] as const) {
    const value = options[key]
    if (value !== undefined && typeof value !== 'boolean' && (typeof value !== 'object' || value === null || Array.isArray(value))) throw new TypeError(`[comice] ${key} must be a boolean or settings object.`)
  }
  if (options.join) {
    const join = options.join === true ? {} : options.join
    if (join.style !== undefined && !['metaball', 'slab'].includes(join.style)) throw new Error('[comice] Join style must be metaball or slab.')
    for (const key of Object.keys(join)) if (!['style', 'points', 'width', 'pinch', 'sag', 'fillet', 'thin', 'dissolve'].includes(key)) throw new Error(`[comice] Unsupported join option: ${key}.`)
    if (join.points !== undefined && (!Array.isArray(join.points) || join.points.length < 2 || join.points.length > 32 || join.points.some((p) => !Array.isArray(p) || p.length !== 2 || p.some((v) => !Number.isFinite(v) || v < 0 || v > 1)))) throw new RangeError('[comice] Join points must contain 2–32 normalized [x, y] centers.')
    for (const value of [join.width, join.pinch, join.sag, join.fillet, join.thin, join.dissolve]) if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new RangeError('[comice] Join settings must be finite and nonnegative.')
    if (join.thin === 0) throw new RangeError('[comice] Join thin must be positive.')
    if ((join.pinch ?? .35) > 1) throw new RangeError('[comice] Join pinch must be in [0, 1].')
  }
  if (options.interaction !== undefined && typeof options.interaction !== 'boolean' && (typeof options.interaction !== 'object' || options.interaction === null || Array.isArray(options.interaction))) throw new TypeError('[comice] Interaction must be a boolean or settings object.')
  const interaction = options.interaction === true ? {} : options.interaction || false
  if (interaction) {
    for (const value of [interaction.radius, interaction.softness, interaction.wake, interaction.decay]) if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new RangeError('[comice] Interaction settings must be finite and nonnegative.')
    if (interaction.radius === 0 || (interaction.decay ?? .94) >= 1) throw new RangeError('[comice] Interaction radius must be positive and decay below 1.')
    for (const key of Object.keys(interaction)) if (!['radius', 'softness', 'wake', 'decay'].includes(key)) throw new Error(`[comice] Unsupported interaction option: ${key}.`)
  }
  if (options.direction !== undefined && !['forward', 'reverse'].includes(options.direction)) throw new Error('[comice] Unknown morph direction.')
  if (!Number.isFinite(liquid) || liquid < 0 || liquid > 1) throw new RangeError('[comice] Liquid must be in [0, 1].')
  if (options.liquidSheen !== undefined && (!Number.isFinite(options.liquidSheen) || options.liquidSheen < 0)) throw new RangeError('[comice] Liquid sheen must be finite and nonnegative.')
  if (options.maskRasterization?.sdf === false) throw new Error('[comice] Morph requires a signed distance mask (sdf: true).')
  // Reject retired options instead of silently ignoring caller intent.
  if (typeof options.cursorFollow === 'object') {
    const { offset, zoom } = options.cursorFollow
    for (const key of Object.keys(options.cursorFollow)) if (!['offset', 'zoom'].includes(key)) throw new Error(`[comice] Unsupported cursorFollow option: ${key}.`)
    if (offset !== undefined && (!Number.isFinite(offset) || offset < 0)) throw new RangeError('[comice] cursorFollow offset must be finite and nonnegative.')
    if (zoom !== undefined && (!Number.isFinite(zoom) || zoom <= 0 || zoom > 2)) throw new RangeError('[comice] cursorFollow zoom must be in (0, 2].')
  }
  if (typeof options.bend === 'object') {
    for (const key of Object.keys(options.bend)) if (!['x', 'y'].includes(key)) throw new Error(`[comice] Unsupported bend option: ${key}.`)
    for (const value of [options.bend.x, options.bend.y]) if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new RangeError('[comice] bend amounts must be finite and nonnegative.')
  }
  for (const key of Object.keys(options)) if (!['to', 'from', 'join', 'direction', 'liquid', 'liquidSheen', 'cursorFollow', 'bend', 'maskRasterization', 'outline', 'glass', 'interaction'].includes(key)) throw new Error(`[comice] Unsupported morph option: ${key}. Supply geometry in from/to.`)
  let mask: ShapeMask | undefined
  const usesMask = true

  let target: Uploadable | null = null
  let glContext: GLContext | null = null
  let reporter: GLReporter | null = null
  let plane: Plane | null = null
  let morphProgram: MorphProgram | null = null
  let pendingProgram: PendingMorphProgram | null = null // compiling in the background
  let rasterizedMask: RasterizedMask | null = null
  let fromRasterizedMask: RasterizedMask | null = null
  let fromSource: ShapeMask | undefined
  const shapeAbort = new AbortController()
  const shapeReleases: Array<() => void> = []
  let maskScale = 1 // Replaced once the real bake dimensions are known.
  let fromScale = 1 // The same, for the `from` field (it can land a frame apart).
  // The media's own frame, for an omitted `from` or `to`: its CSS clip-path, or its
  // box with the border-radius set on it (any corner, elliptical or percentage).
  let capturedFrame: ShapeMask | undefined
  let frameDescription = ''
  function readFrame(element: Element): ShapeMask {
    const style = getComputedStyle(element)
    const radii = [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius].map(radiusPair)
    const horizontal = radii.map(v => v[0]).join(' ')
    const vertical = radii.map(v => v[1]).join(' ')
    frameDescription = style.clipPath && style.clipPath !== 'none' ? style.clipPath : `inset(0px round ${horizontal} / ${vertical})`
    return compileClipPath(frameDescription)
  }
  let sourceRadius = 0 // The media's own corner radius, read on layout changes, never per frame.
  let dirty = true // Something changed since the last draw.
  let lastDraw = '' // What the last frame drew, to skip identical frames.
  let unsubscribe: (() => void) | null = null
  let unregisterFromScheduler: (() => void) | null = null
  let visibility: ReturnType<typeof createVisibilityGate> | null = null
  let resizeObserver: ResizeObserver | null = null
  let mount: CanvasMount | null = null
  let requestedProgress = 0
  let currentProgress = 0
  let painted = false
  let destroyed = false
  let revealedAt = 0 // when the canvas first replaced the media
  let gaveUp = false // the effect never painted; the original media is shown for good
  let giveUpTimer: ReturnType<typeof setTimeout> | undefined
  // The media's own visibility, while the plugin holds it hidden before its canvas exists
  // (the shape files are still loading); undefined when it is not holding it.
  let earlyOriginal: string | undefined
  let contextLost: (() => void) | null = null
  let lastBake = ''
  let bakeGeneration = 0
  let baking = false
  let failEffect: (error: unknown) => void
  const resolvedJoin: JoinOptions | false = options.join === true ? {} : options.join || false
  const automaticJoins = !!resolvedJoin && !resolvedJoin.points
  const joinPoints = new Float32Array(64)
  let joinCount = 0
  let joinFrom = true

  // Core mappings drive independent pointer and velocity channels.
  let mouseX = 0
  let mouseY = 0
  let velocity = 0
  // The page's pointer and scroll speed feed those channels unless something else drives
  // them: the first write to a channel from outside hands it over for good.
  let windowInput: WindowInput | null = null
  const driven = { mouseX: false, mouseY: false, velocity: false }
  let detachPointer: (() => void) | null = null
  const pointerState = new Float32Array([.5, .5, 0, 0])
  let pointerPresence = 0, pointerSpeed = 0, seconds = 0

  let lastInputTick = 0
  function tickInput(deltaMs: number): void {
    if (!windowInput) return
    // Not ticked for a while (scrolled out of view, a hidden tab): the page's scroll speed
    // has decayed in the meantime, so start from rest rather than from the stale value.
    const at = performance.now()
    if (lastInputTick && at - lastInputTick > 250) windowInput.settle()
    lastInputTick = at
    windowInput.tick(deltaMs)
    if (!driven.mouseX) mouseX = windowInput.mouseX
    if (!driven.mouseY) mouseY = windowInput.mouseY
    if (!driven.velocity) velocity = windowInput.velocity
  }

  function tickInteraction(deltaMs: number): void {
    if (!interaction) return
    const frames = Math.max(0, Math.min(deltaMs, 50)) * .06
    const active = prefersReducedMotion() ? 0 : pointerPresence
    pointerState[2] += (active - pointerState[2]!) * (1 - Math.pow(.88, frames))
    pointerState[3] = active ? Math.max(pointerState[3]! * Math.pow(interaction.decay ?? .94, frames), Math.min(1, pointerSpeed / 2600)) : pointerState[3]! * Math.pow(interaction.decay ?? .94, frames)
    // A wake animates only while it can affect the visible silhouette. At rest,
    // a still image must stop drawing rather than following an invisible clock.
    if (pointerState[3]! < 1e-4) pointerState[3] = 0
    if (Math.abs(active - pointerState[2]!) < 1e-4) pointerState[2] = active
    if (pointerState[3] && (interaction.wake ?? 3) > 0 && currentProgress > 0 && currentProgress < 1 && !prefersReducedMotion()) seconds += frames / 60
  }

  function rasterizeMaskIfNeeded(cssWidth: number, cssHeight: number): void {
    if (!rasterizedMask || !mask || cssWidth <= 0 || cssHeight <= 0) return
    const rasterOptions: RasterizeOptions & { maxDistance: number } = { sdf: true, maxDistance: MASK_BAKE_MAX_DISTANCE, fill: 1, precision: 'half' as const, bounded: true, ...options.maskRasterization }
    if (!rasterOptions.resolution) {
      // One texel per CSS pixel. The field is a signed distance with
      // fractional edge coverage, interpolated on the GPU, so edges stay
      // sub-pixel smooth at any device pixel ratio; baking at 2x cost four
      // times the work for no visible difference.
      const scale = Math.min(1, 2048 / Math.max(cssWidth, cssHeight))
      rasterOptions.resolution = [Math.max(1, Math.round(cssWidth * scale)), Math.max(1, Math.round(cssHeight * scale))]
    }
    const bakeHeightTexels = rasterOptions.resolution?.[1] ?? Math.max(1, Math.round(cssHeight * effectiveDPR()))
    const bakeWidthTexels = rasterOptions.resolution?.[0] ?? Math.max(1, Math.round(cssWidth * effectiveDPR()))
    if (options.maskRasterization?.maxDistance === undefined) rasterOptions.maxDistance = Math.max(bakeWidthTexels, bakeHeightTexels)
    const bakeKey = `${cssWidth}:${cssHeight}:${bakeWidthTexels}:${bakeHeightTexels}`
    if (bakeKey === lastBake) return
    lastBake = bakeKey
    const generation = ++bakeGeneration
    baking = true
    // maskScale converts the bake's texel-space distance into this shader's
    // aspect-normalized st space: one st unit of height is the bake's full
    // height in texels, so a half-float (signed texel) field scales by
    // 1 / height, and a byte field by maxDistance / height. From the REAL bake
    // dimensions, never a hand-tuned constant.
    const scale = rasterOptions.precision === 'half' ? 1 / bakeHeightTexels : rasterOptions.maxDistance / bakeHeightTexels
    // The distance transform runs on a background worker (core's mask.ts), so
    // a demo scrolling into view never stalls the page; each field takes over
    // when it arrives, and until then the previous one (or the untouched media)
    // stays on screen.
    // `fill` fits the destination inside the media; the start is authored at
    // stage size, and the media's own frame has to fill its box to match the media itself.
    const bake = { ...rasterOptions, components: !!resolvedJoin, background: true }
    const settle = () => {
      if (resolvedJoin && rasterizedMask) {
        const fromPoints = fromRasterizedMask?.components ?? [], toPoints = rasterizedMask.components
        joinFrom = fromPoints.length >= toPoints.length
        const points = automaticJoins ? (joinFrom ? fromPoints : toPoints) : resolvedJoin.points ?? []
        joinCount = points.length
        points.forEach(([x, y], i) => { joinPoints[i * 2] = x; joinPoints[i * 2 + 1] = y })
      }
      dirty = true
      renderFrame(true)
    }
    try {
      const toBake = rasterizedMask.rasterize(typeof mask === 'function' ? mask(cssWidth, cssHeight) : mask, cssWidth, cssHeight, { ...bake, components: !!resolvedJoin })
      const fromMask = typeof fromSource === 'function' ? fromSource(cssWidth, cssHeight) : fromSource
      const fromBake = fromMask ? fromRasterizedMask?.rasterize(fromMask, cssWidth, cssHeight, { ...bake, fill: fromMask.type === 'text' ? bake.fill : 1 }) : undefined
      Promise.all([toBake, fromBake]).then(([to, from]) => {
        if (destroyed || generation !== bakeGeneration) return
        baking = false
        // Commit all scales together. Until every field arrives, keep the last
        // canvas frame: blending differently sized fields makes the edge jump.
        if (to === false || from === false || !rasterizedMask?.field || (fromSource && !fromRasterizedMask?.field)) {
          failEffect(new Error('[comice] morph(): Could not prepare the distance fields. The original media is shown.'))
          return
        }
        maskScale = scale
        fromScale = scale
        settle()
      }).catch(error => { if (generation === bakeGeneration) failEffect(error) })
    } catch (error) { baking = false; failEffect(error) }
  }

  /** Joins the shared loop: off-screen, in a hidden tab, or once the frame
   *  budget has dropped to a static poster (core's budget.ts), this does zero
   *  work. `isConnected` alone kept every effect drawing while scrolled away. */
  function schedule(): void {
    unregisterFromScheduler?.()
    unregisterFromScheduler = getSharedScheduler().add(
      (deltaMs) => { tickInput(deltaMs); tickInteraction(deltaMs); renderFrame() },
      () => !destroyed && !!target && target.isConnected && (visibility!.shouldDraw() || (!painted && visibility!.isVisible())),
    )
  }

  /** Pointer interaction, attached once the shader is ready to use it. */
  function startPointer(): void {
    if (!interaction || detachPointer || !target) return
    detachPointer = pointer({ radius: 0, lag: .7 }).attach(target, (signal) => {
      if (!target || !visibility?.shouldDraw() || prefersReducedMotion()) { pointerPresence = 0; pointerSpeed = 0; return }
      const rect = target.getBoundingClientRect()
      pointerPresence = signal.progress
      pointerSpeed = signal.velocity ?? 0
      if (signal.pointer && rect.width > 0 && rect.height > 0) {
        pointerState[0] = signal.pointer.x / rect.width
        pointerState[1] = signal.pointer.y / rect.height
      }
    })
    // The pointer's own frame callback has to run before the draw that reads it,
    // or every frame draws the pointer one frame late: rejoin the loop after it.
    if (unregisterFromScheduler) schedule()
  }

  /** Bakes (if needed) at the canvas's layout size, or the media's box while
   *  the canvas has not been laid out yet (it reports 0 until then). One size
   *  source for every caller, so the same shape is never baked twice. */
  function bakeAtLayoutSize(): void {
    if (!glContext || !target) return
    // Use the same untransformed layout box as mountCanvas, before resizing
    // its backing store. The canvas still has the previous CSS size here.
    const width = target.offsetWidth, height = target.offsetHeight
    const box = width > 0 && height > 0 ? null : target.getBoundingClientRect()
    rasterizeMaskIfNeeded(box ? Math.round(box.width) : width, box ? Math.round(box.height) : height)
  }

  /**
   * What shows under the still-empty canvas before the first real frame. The
   * media is shown only while it looks exactly like the effect's frame right now:
   * at an end that IS the media's own frame (an omitted `from` or `to`). Anywhere
   * else (mid-morph, or either end a shape of your own) the media would be the
   * wrong shape, so it stays hidden and the effect eases in from empty, rather
   * than a plain box showing under a half-morphed shape.
   */
  /** Whether the media, as the page shows it, looks exactly like the effect right now. */
  function mediaMatches(): boolean {
    const progress = snapForReducedMotion(requestedProgress)
    const effective = options.direction === 'reverse' ? 1 - progress : progress
    // A near-end silhouette or a live bend still differs at the corners. Even a
    // 1% mismatch exposes a rectangular layer under the moving top edge.
    if (options.bend && !prefersReducedMotion() && effective > 0 && effective < 1 && velocity !== 0) return false
    if (options.from === undefined && options.to === undefined) return true
    return (options.from === undefined && effective === 0) || (options.to === undefined && effective === 1)
  }
  function syncPlaceholder(): void {
    if (painted || gaveUp || !target) return
    const showsFrame = mediaMatches()
    if (mount) { mount.holdTarget(showsFrame); return }
    // No canvas yet: the same rule, on the media itself.
    if (!showsFrame && earlyOriginal === undefined) { earlyOriginal = target.style.visibility; target.style.visibility = 'hidden' }
    else if (showsFrame) releaseEarly()
  }
  /** Gives the media back its own visibility, if the plugin was holding it hidden. */
  function releaseEarly(): void {
    if (earlyOriginal === undefined) return
    if (target) target.style.visibility = earlyOriginal
    earlyOriginal = undefined
  }
  /** If the effect has not painted within ten seconds while on screen (a shape
   *  that never loads, a bake that never lands), the original media comes back for
   *  good. Off screen it simply waits: nothing is drawn there by design. */
  function armGiveUp(): void {
    giveUpTimer = setTimeout(() => {
      if (destroyed || painted) return
      const rect = target?.getBoundingClientRect()
      if (!rect || rect.bottom < 0 || rect.top > innerHeight) { armGiveUp(); return }
      gaveUp = true
      failEffect(new Error('[comice] morph(): Timed out preparing the shape. The original media is shown.'))
    }, 10000)
  }

  /**
   * How far the media's cursor-follow zoom and parallax have eased in. The canvas takes over from the
   * media showing exactly what the media showed (a zoom of 1, no offset), and only once the handoff
   * has finished does the zoom ease toward its margin and the media start to follow the cursor;
   * otherwise the two layers, a different crop each, show as a double image while they cross over.
   * Reduced motion keeps the zoom at 1, as it has no parallax to need the margin for.
   */
  function followAmount(reduced: boolean): number {
    if (options.cursorFollow === false || reduced || !revealedAt) return 0
    const t = Math.max(0, Math.min(1, (performance.now() - revealedAt - HANDOFF_MS) / FOLLOW_EASE_MS))
    return t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
  }

  /** The media's corner radius, which the frame shape follows. Read on layout
   *  changes only: a getComputedStyle() per frame forces style work mid-scroll. */
  function readRadius(): void {
    if (target) sourceRadius = parseFloat(getComputedStyle(target).borderTopLeftRadius) || 0
  }

  /** Whether anything on screen can have changed since the last draw. A still
   *  image at rest is not redrawn 60 times a second for nothing. */
  function frameKey(): string {
    // plane.frame changes only when a new video frame was uploaded, so a
    // playing video is drawn at its own frame rate, not at every tick.
    return `${currentProgress}|${mouseX}|${mouseY}|${velocity}|${pointerState.join(',')}|${seconds}|${plane?.frame ?? 0}|${followAmount(prefersReducedMotion())}`
  }

  function renderFrame(force = false): void {
    if (destroyed || gaveUp || !glContext || !plane || !target) return
    // The shader compiles in the background (shape-program.ts); until it is
    // done the media simply stays on screen, and the shared loop checks again
    // next frame.
    if (pendingProgram) {
      if (!morphProgramReady(glContext.gl, pendingProgram)) return
      morphProgram = finishMorphProgram(glContext.gl, pendingProgram)
      pendingProgram = null
      if (!morphProgram) {
        reporter?.noProgram()
        plugin.teardown?.()
        return
      }
      startPointer()
    }
    if (!morphProgram) return
    if (plane.error) { reporter?.afterDraw(plane); plugin.teardown?.(); return }
    if (visibility && !(visibility.shouldDraw() || ((force || !painted) && visibility.isVisible()))) return
    currentProgress = snapForReducedMotion(requestedProgress)
    const key = frameKey()
    if (!force && !dirty && painted && key === lastDraw) return
    const reduced = prefersReducedMotion()
    if (usesMask) bakeAtLayoutSize()
    if (baking || destroyed) return
    glContext.resizeToDisplay()
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
      follow: followAmount(reduced),
      mediaAspect,
      resolutionWidth: glContext.canvas.clientWidth || 1,
      resolutionHeight: glContext.canvas.clientHeight || 1,
      maskTexture: rasterizedMask?.field?.kind === 'texture' ? rasterizedMask.field.texture : null,
      maskScale,
      fromMaskTexture: fromRasterizedMask?.field?.kind === 'texture' ? fromRasterizedMask.field.texture : null,
      fromScale,
      sourceRadius,
      joinPoints,
      joinCount,
      joinFrom,
      interaction: reduced ? [0, 0, 0, 0] : pointerState,
      time: seconds,
    })
    painted = !!plane.texture && (!usesMask || !!rasterizedMask?.field) && (!fromSource || !!fromRasterizedMask?.field)
    if (painted) {
      // The media stays visible under the (still empty) canvas until this,
      // the first frame that really replaces it.
      // Eased in rather than switched: the bake finishes off the main thread,
      // possibly a moment after the media is already on screen.
      if (!revealedAt) {
        revealedAt = performance.now()
        // Input may have changed since the last placeholder update. Never
        // crossfade a rectangular source underneath a different silhouette.
        if (!mediaMatches()) mount?.holdTarget(false)
        mount?.hideTarget(reduced ? 0 : HANDOFF_MS)
      }
      // The handoff fades the media out under the canvas, which is only invisible while the
      // two match. If a fast scroll has moved the effect away from the media's frame during
      // the fade, finish it now rather than leave half a box under the shape.
      else if (performance.now() - revealedAt < 400 && !mediaMatches()) mount?.completeReveal()
      dirty = false
      lastDraw = key
      reporter?.afterDraw(plane)
    }
  }

  /** `immediate` for `.set()` and mappings, which promise the value is drawn
   *  now (like gsap.set()); progress from a driver can arrive several times a
   *  frame (scroll events) and is drawn once, on the next frame. */
  function render(progress: number, immediate = false): void {
    // Reduced motion: jump to whichever end state is closer, never animate between.
    if (!Number.isFinite(progress)) return
    const next = Math.max(0, Math.min(1, progress))
    if (next !== requestedProgress) dirty = true
    requestedProgress = next
    syncPlaceholder()
    currentProgress = snapForReducedMotion(requestedProgress)
    // While the shared loop is drawing, it picks this up on its next frame, so
    // several progress events in one frame cost one draw. Otherwise (hidden,
    // poster mode, not started) draw now, so `.set()` always shows.
    if (!immediate && unregisterFromScheduler && visibility?.shouldDraw() && painted) return
    renderFrame(true)
  }

  const plugin: ComicePlugin = {
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
      if (target || destroyed) throw new Error('[comice] A morph plugin instance can only be attached once; use create() for a fresh copy.')
      target = rawTarget
      failEffect = (error) => {
        if (destroyed) return
        plugin.teardown?.()
        instance.fail('morph', error instanceof Error ? error : new Error(String(error)))
      }
      requestedProgress = instance.progress
      armGiveUp()
      syncPlaceholder()
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
        if (!glContext) { reporter.noContext(); plugin.teardown?.(); return }
        if (glContext) {
          releaseEarly() // the mount records the media's own visibility, so give it back first
          try { mount = mountCanvas(glContext, target, { owner: 'morph', hideTarget: false }) }
          catch (error) { glContext = null; target = null; throw error }
          const canvas = glContext.canvas
          const lost = () => failEffect(new Error('[comice] morph(): WebGL context was lost. The original media is shown.'))
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
          readRadius()
          // Start baking now, even before the media is on screen: the bake runs
          // off the main thread, so a page that mounts effects a little ahead of
          // the viewport has them ready by the time they scroll in.
          bakeAtLayoutSize()
          if (destroyed) return
        }

        if (glContext) {
          pendingProgram = beginMorphProgram(glContext.gl, {
            ...options,
            join: resolvedJoin,
            shapeTransition: true,
            textTransition: !!(fromSource && typeof fromSource !== 'function' && fromSource.type === 'text' && mask && typeof mask !== 'function' && mask.type === 'text'),
            signedMask: (options.maskRasterization?.precision ?? 'half') === 'half',
            hasFromMask: true,
            liquid,
          })
          // Could not even allocate one: show the original instead of an empty canvas.
          if (!pendingProgram) {
            reporter.noProgram()
            plugin.teardown?.()
            return
          }
        }

        resizeObserver = new ResizeObserver(() => {
          // renderFrame() re-bakes from the canvas's new layout size. A frame taken from
          // the media follows it if its radius changed (a media query, a class).
          if (target && (options.from === undefined || options.to === undefined)) {
            const before = frameDescription
            const next = readFrame(target)
            if (frameDescription !== before) {
              capturedFrame = next
              if (options.to === undefined) mask = next
              if (options.from === undefined) fromSource = next
              lastBake = ''
            }
          }
          readRadius()
          dirty = true
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
        const followCursor = options.cursorFollow !== false
        const bends = !!options.bend
        if (followCursor || bends) windowInput = trackWindowInput({ pointer: followCursor, scroll: bends })
        schedule()
        syncPlaceholder()

        render(requestedProgress)
      }
      {
        capturedFrame = readFrame(rawTarget)
        // Keep the original media visible while URL/SVG inputs load. Progress
        // mappings can already write their requested value during this wait.
        const load = (shape: MorphShape) => resolveShape(shape, shapeAbort.signal, rawTarget.ownerDocument).then((resolved) => {
          if (destroyed) { resolved.release(); throw new DOMException('Shape load aborted.', 'AbortError') }
          shapeReleases.push(resolved.release)
          return resolved
        })
        Promise.all([options.to !== undefined ? load(options.to) : Promise.resolve(undefined), options.from !== undefined ? load(options.from) : Promise.resolve(undefined)]).then(([destination, source]) => {
          if (destroyed) return
          mask = destination?.mask ?? capturedFrame
          fromSource = source?.mask ?? capturedFrame
          initialize()
        }).catch(failEffect)
      }
    },

    teardown() {
      destroyed = true
      windowInput?.destroy()
      windowInput = null
      clearTimeout(giveUpTimer)
      releaseEarly()
      shapeAbort.abort()
      shapeReleases.splice(0).forEach((release) => release())
      unregisterFromScheduler?.()
      detachPointer?.(); detachPointer = null
      visibility?.destroy()
      visibility = null
      unsubscribe?.()
      resizeObserver?.disconnect()
      contextLost?.()
      if (glContext && morphProgram) destroyMorphProgram(glContext.gl, morphProgram)
      if (glContext && pendingProgram) abandonMorphProgram(glContext.gl, pendingProgram)
      pendingProgram = null
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
      capturedFrame = undefined
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
          render(value, true)
          return
        }
        if (name === 'mouseX') {
          driven.mouseX = true
          mouseX = value
          return
        }
        if (name === 'mouseY') {
          driven.mouseY = true
          mouseY = value
          return
        }
        if (name === 'velocity') {
          driven.velocity = true
          velocity = value
          return
        }
      },
    },
  }
  return plugin
}

export type { MorphShape } from './shape-input.js'
export type { JoinOptions } from './shape-shader.js'
export type { GlassOptions, OutlineOptions } from './surface.js'
export type { ClipPathShape } from './clip-path.js'
