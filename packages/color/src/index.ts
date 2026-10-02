/**
 * @comice/color
 * ─────────────────────────────────────────────────────────────────────────────
 * How media is graded, stylised and physically finished — spec §08's own
 * words. T9 (ROADMAP.md §4). See shader.ts's own header for the full effect
 * breakdown, pipeline order, and why `dof` is out of scope this pass.
 *
 * TARGET, LIKE morph/distort: the target `<img>`/`<video>` IS the media —
 * setup() hides it (`visibility: hidden`) and inserts a WebGL2 canvas in
 * its place, same pattern every single-media shader plugin in this repo
 * uses.
 *
 * NOT STATE-MACHINE DRIVEN: unlike reveal/spotlight/morph, color has no
 * natural idle/entering/active/leaving story — a grade is either on or
 * it's on, spec's own card describes no progress-driven behavior at all
 * (contrast with dissolve's explicit "progress: number, Mappable" line).
 * color still exposes MappableTarget params (grainSeed, bloomIntensity,
 * aberrationAmount) so a driver CAN animate them, but nothing here reacts
 * to instance.state — render() is called once at setup() and again only
 * when a param changes or the element resizes.
 */

import type { ComiceInstance, ComicePlugin } from 'comice'
import { createGLContext, createPlane, getResidencyPool, mountCanvas, type CanvasMount, type GLContext, type Plane } from 'comice/gl'
import { createVisibilityGate, getSharedScheduler } from 'comice/scheduler'
import { compileColorProgram, destroyColorProgram, drawColor, type ColorDrawState, type ColorEffect, type ColorProgram } from './shader.js'
import { packLutTexture, parseCubeLut } from './lut.js'
import type { AberrationOptions, BloomOptions, DuotoneOptions, GrainOptions } from './shader.js'

export type ColorOptions = {
  /** Which effects are active, applied in a fixed pipeline order (see
   *  shader.ts's header) — composable, not mutually exclusive, matching
   *  spec's own chip-row card (no "Default" column, unlike dissolve's
   *  `transition` or distort's `effect`). Default: none (a color() with
   *  no effects is a harmless passthrough, useful only as a mapping
   *  target that will be configured later — matches every other plugin's
   *  "no-op until configured" tolerance). */
  effects?: readonly ColorEffect[]
  /** Path to a .cube file, spec's own `lut` option exactly. Fetched and
   *  parsed at setup(); required if `effects` includes 'lut'. */
  lut?: string
  /** Colour blend space for duotone's shadow<->highlight interpolation.
   *  Default 'oklch', matching spec exactly. */
  interpolate?: 'oklch' | 'rgb'
  duotone?: DuotoneOptions
  grain?: GrainOptions
  bloom?: BloomOptions
  aberration?: AberrationOptions
}

type Uploadable = HTMLImageElement | HTMLVideoElement

function isUploadableSource(target: Element): target is Uploadable {
  return target instanceof HTMLImageElement || target instanceof HTMLVideoElement
}

/** Uploads a packed LUT (see lut.ts) as an RGBA8 2D texture. Returns null,
 *  never throws, on any GL failure — degrade-never-disappear: a LUT that
 *  fails to upload just means the 'lut' effect chunk samples an empty
 *  texture (a uniform mid-grey read), not a crash. */
function uploadLutTexture(gl: WebGL2RenderingContext, packed: { width: number; height: number; pixels: Uint8Array }): WebGLTexture | null {
  const texture = gl.createTexture()
  if (!texture) return null
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, packed.width, packed.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, packed.pixels)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.bindTexture(gl.TEXTURE_2D, null)
  return texture
}

export function color(options: ColorOptions = {}): ComicePlugin {
  const { effects = [], lut, interpolate = 'oklch', duotone, grain, bloom, aberration } = options

  let target: Uploadable | null = null
  let glContext: GLContext | null = null
  let plane: Plane | null = null
  let colorProgram: ColorProgram | null = null
  let lutTexture: WebGLTexture | null = null
  let lutSize = 2
  let unregisterFromScheduler: (() => void) | null = null
  let visibility: ReturnType<typeof createVisibilityGate> | null = null
  let resizeObserver: ResizeObserver | null = null
  let mount: CanvasMount | null = null
  let destroyed = false

  let grainAmount = grain?.amount ?? 0.08
  let bloomIntensity = bloom?.intensity ?? 0.6
  let bloomThreshold = bloom?.threshold ?? 0.7
  let aberrationAmount = aberration?.amount ?? 0.004
  let grainSeed = 0

  function renderFrame(): void {
    if (destroyed || !glContext || !plane || !colorProgram) return
    glContext.resizeToDisplay()

    const cssWidth = glContext.canvas.clientWidth || 1
    const cssHeight = glContext.canvas.clientHeight || 1

    getResidencyPool(glContext).beginPass()
    const state: ColorDrawState = {
      resolutionWidth: cssWidth,
      resolutionHeight: cssHeight,
      bloomThreshold,
      bloomIntensity,
      aberrationAmount,
      grainAmount,
      grainSeed,
    }
    drawColor(glContext, colorProgram, plane, lutTexture, state)
  }

  return {
    name: 'color',

    setup(rawTarget: Element, _instance: ComiceInstance) {
      if (!isUploadableSource(rawTarget)) {
        throw new Error('[comice] color() requires an <img> or <video> target.')
      }
      if (effects.includes('lut') && !lut) {
        throw new Error("[comice] color(): effects includes 'lut' but no `lut` path was provided.")
      }
      target = rawTarget

      // Degrade-never-disappear: with no WebGL2 nothing is mounted and the
      // original, ungraded media stays as the browser shows it. See
      // mountCanvas() for sizing, hiding/restoring, and the one-GL-effect-
      // per-element rule.
      glContext = createGLContext(target)
      if (glContext) {
        mount = mountCanvas(glContext, target, { owner: 'color', hideTarget: true })
      }

      plane = createPlane(glContext, target)

      if (glContext) {
        colorProgram = compileColorProgram(glContext.gl, {
          effects,
          interpolate,
          duotone,
          lut: effects.includes('lut') ? { size: lutSize } : undefined,
          grain,
          bloom,
          aberration,
        })
        // A failed compile would otherwise leave the media hidden behind an
        // empty canvas; show the original instead.
        if (!colorProgram) mount?.release()

        if (effects.includes('lut') && lut) {
          fetch(lut)
            .then((res) => res.text())
            .then((text) => {
              if (destroyed || !glContext) return
              const parsed = parseCubeLut(text)
              lutSize = parsed.size
              const packed = packLutTexture(parsed)
              lutTexture = uploadLutTexture(glContext.gl, packed)
              // The LUT program was compiled with a placeholder size (2)
              // before the real .cube size was known — recompile now that
              // it is, so buildLutGLSL()'s tile math matches the actually
              // uploaded texture's layout. The placeholder program is kept
              // alive only by this local reference (its cache key,
              // `lut.size: 2`, is never a real caller-intended config —
              // only ever this transient pre-fetch placeholder), so it's
              // destroyed here rather than left to leak: shader.ts's
              // reference-counted cache only frees a program when its
              // holder releases it, and this is that holder.
              const staleProgram = colorProgram
              colorProgram = compileColorProgram(glContext.gl, {
                effects,
                interpolate,
                duotone,
                lut: { size: lutSize },
                grain,
                bloom,
                aberration,
              })
              if (staleProgram && staleProgram !== colorProgram) {
                destroyColorProgram(glContext.gl, staleProgram)
              }
              renderFrame()
            })
            .catch(() => {
              // Degrade-never-disappear: a failed LUT fetch/parse leaves
              // 'lut' compiled but with no texture bound — drawColor()'s
              // own lutUnit fallback (see shader.ts) means this samples
              // whatever's on unit 0 rather than throwing.
            })
        }
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

      renderFrame()
    },

    teardown() {
      destroyed = true
      unregisterFromScheduler?.()
      visibility?.destroy()
      visibility = null
      resizeObserver?.disconnect()
      if (glContext && colorProgram) destroyColorProgram(glContext.gl, colorProgram)
      if (glContext && lutTexture) glContext.gl.deleteTexture(lutTexture)
      plane?.destroy()
      mount?.release()
      mount = null
      target = null
      glContext = null
      plane = null
      colorProgram = null
      lutTexture = null
      resizeObserver = null
    },

    // MappableTarget: the per-effect intensity knobs a driver can scrub
    // live, matching spec's own composable-effects card (there's no
    // single "progress" the way dissolve/reveal have one).
    params: {
      getParam(name: string): number {
        switch (name) {
          case 'grainAmount':
            return grainAmount
          case 'bloomIntensity':
            return bloomIntensity
          case 'bloomThreshold':
            return bloomThreshold
          case 'aberrationAmount':
            return aberrationAmount
          case 'grainSeed':
            return grainSeed
          default:
            return 0
        }
      },
      setParam(name: string, value: number): void {
        switch (name) {
          case 'grainAmount':
            grainAmount = value
            break
          case 'bloomIntensity':
            bloomIntensity = value
            break
          case 'bloomThreshold':
            bloomThreshold = value
            break
          case 'aberrationAmount':
            aberrationAmount = value
            break
          case 'grainSeed':
            grainSeed = value
            break
          default:
            return
        }
        renderFrame()
      },
    },
  }
}

export type { ColorEffect } from './shader.js'
