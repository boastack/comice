/**
 * @comice/mosaic
 * ─────────────────────────────────────────────────────────────────────────────
 * Media rebuilt from cells, still reading as a photograph — spec §08's own
 * words. T10 (ROADMAP.md §4). All six fills ship: `dither`, `halftone`,
 * `riso`, `pixelate`, `crosshatch`, `images`. See shader.ts's own header
 * for the per-fill math and the ordered-vs-error-diffusion dither
 * distinction spec's own Excludes line draws.
 *
 * TARGET, LIKE morph/distort/color: the target `<img>`/`<video>` IS the
 * media — setup() hides it and inserts a WebGL2 canvas in its place.
 *
 * NOT STATE-MACHINE DRIVEN, SAME REASONING AS `color`: spec's own card
 * describes no progress-driven behavior for mosaic — a cell fill is
 * either applied or it isn't. `cell` is still a live MappableTarget
 * parameter (a driver CAN animate it), but nothing here subscribes to
 * `instance.on('*')` — render() runs once at setup() and again only when
 * a param changes or the element resizes.
 *
 * `sources` (fill: 'images' ONLY): spec's own `sources: Media[]` option,
 * "Tile pool for fill: 'images'." Uploaded as additional planes bound
 * alongside the media texture through the shared ResidencyPool — the same
 * ResidencyPool mechanism dissolve's two-texture pass and morph's
 * media+mask pass both already exercise, now with an arbitrary-length
 * pool rather than a fixed count.
 */

import type { ComiceInstance, ComicePlugin } from 'comice'
import { createGLContext, createPlane, getResidencyPool, type GLContext, type Plane } from 'comice/gl'
import { getSharedScheduler } from 'comice/scheduler'
import { compileMosaicProgram, destroyMosaicProgram, drawMosaic, type MosaicFill, type MosaicProgram } from './shader.js'

export type MosaicOptions = {
  /** Which fill drives the cell reconstruction. Required, matching spec exactly. */
  fill: MosaicFill
  /** Cell size, px. Default 12. */
  cell?: number
  /** Brand colours, or a count. Matches spec's own `string[] | number`
   *  exactly — an explicit palette array is accepted for API fidelity
   *  and future color-remap work, but this pass's shader only consumes
   *  the COUNT (see shader.ts's own header) for `dither`'s quantization
   *  levels and `images`'s bucket count; a caller-supplied color list
   *  does not yet drive per-bucket recoloring. Default 2. */
  palette?: readonly string[] | number
  /** Tile pool for `fill: 'images'`. Ignored for every other fill.
   *  Required (throws at construction) when `fill: 'images'`. */
  sources?: readonly (HTMLImageElement | HTMLVideoElement)[]
}

type Uploadable = HTMLImageElement | HTMLVideoElement

function isUploadableSource(target: Element): target is Uploadable {
  return target instanceof HTMLImageElement || target instanceof HTMLVideoElement
}

function paletteCount(palette: MosaicOptions['palette']): number {
  if (typeof palette === 'number') return Math.max(2, Math.round(palette))
  if (Array.isArray(palette)) return Math.max(2, palette.length)
  return 2
}

export function mosaic(options: MosaicOptions): ComicePlugin {
  const { fill, cell = 12, palette = 2, sources = [] } = options

  if (fill === 'images' && sources.length === 0) {
    throw new Error("[comice] mosaic(): fill 'images' requires a non-empty `sources` array.")
  }

  let target: Uploadable | null = null
  let glContext: GLContext | null = null
  let plane: Plane | null = null
  let sourcePlanes: Plane[] = []
  let mosaicProgram: MosaicProgram | null = null
  let unregisterFromScheduler: (() => void) | null = null
  let resizeObserver: ResizeObserver | null = null
  let originalVisibility = ''
  let destroyed = false
  let cellSize = cell

  function renderFrame(): void {
    if (destroyed || !glContext || !plane || !mosaicProgram) return
    glContext.resizeToDisplay()

    const cssWidth = glContext.canvas.clientWidth || 1
    const cssHeight = glContext.canvas.clientHeight || 1

    getResidencyPool(glContext).beginPass()
    drawMosaic(glContext, mosaicProgram, plane, sourcePlanes, {
      resolutionWidth: cssWidth,
      resolutionHeight: cssHeight,
      cell: cellSize,
    })
  }

  return {
    name: 'mosaic',

    setup(rawTarget: Element, _instance: ComiceInstance) {
      if (!isUploadableSource(rawTarget)) {
        throw new Error('[comice] mosaic() requires an <img> or <video> target.')
      }
      target = rawTarget

      originalVisibility = target.style.visibility
      target.style.visibility = 'hidden'

      const parent = target.parentElement
      if (parent && getComputedStyle(parent).position === 'static') {
        parent.style.position = 'relative'
      }
      glContext = createGLContext(target)
      if (glContext) {
        target.insertAdjacentElement('afterend', glContext.canvas)
      }
      if (!glContext) {
        target.style.visibility = originalVisibility
      }

      plane = createPlane(glContext, target)
      sourcePlanes = sources.map((source) => createPlane(glContext, source))

      if (glContext) {
        mosaicProgram = compileMosaicProgram(glContext.gl, {
          fill,
          cell: cellSize,
          paletteCount: paletteCount(palette),
          sourceCount: sources.length,
        })
      }

      resizeObserver = new ResizeObserver(() => renderFrame())
      resizeObserver.observe(target)

      unregisterFromScheduler = getSharedScheduler().add(
        () => renderFrame(),
        () => !destroyed && !!target && target.isConnected,
      )

      renderFrame()
    },

    teardown() {
      destroyed = true
      unregisterFromScheduler?.()
      resizeObserver?.disconnect()
      if (glContext && mosaicProgram) destroyMosaicProgram(glContext.gl, mosaicProgram)
      plane?.destroy()
      sourcePlanes.forEach((p) => p.destroy())
      glContext?.canvas.remove()
      if (target) target.style.visibility = originalVisibility
      target = null
      glContext = null
      plane = null
      sourcePlanes = []
      mosaicProgram = null
      resizeObserver = null
    },

    // MappableTarget: `cell` is mosaic's one live-mappable parameter — a
    // driver can scrub cell size directly (e.g. scroll-driven pixelation
    // that coarsens as an element leaves view).
    params: {
      getParam(name: string): number {
        if (name === 'cell') return cellSize
        return 0
      },
      setParam(name: string, value: number): void {
        if (name !== 'cell') return
        cellSize = Math.max(1, value)
        renderFrame()
      },
    },
  }
}

export type { MosaicFill } from './shader.js'
