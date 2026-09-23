/**
 * @comice/ascii
 * ─────────────────────────────────────────────────────────────────────────────
 * Media rebuilt from characters, live, on the GPU — spec §08's own words.
 * T10 (ROADMAP.md §4). See shader.ts's own header for the SDF-atlas
 * mechanism and atlas.ts for the rasterization it's built from.
 *
 * TARGET, LIKE morph/distort/color/mosaic: the target `<img>`/`<video>`
 * IS the media.
 *
 * NOT STATE-MACHINE DRIVEN, SAME REASONING AS `color`/`mosaic`: an ascii
 * reconstruction is either applied or it isn't — spec's own card
 * describes no progress-driven behavior. `cell` is still a live
 * MappableTarget parameter; nothing here subscribes to `instance.on('*')`.
 */

import type { ComiceInstance, ComicePlugin } from 'comice'
import { createGLContext, createPlane, getResidencyPool, type GLContext, type Plane } from 'comice/gl'
import { getSharedScheduler } from 'comice/scheduler'
import { compileAsciiProgram, destroyAsciiProgram, drawAscii, type AsciiProgram } from './shader.js'
import { buildGlyphAtlas } from './atlas.js'

export type AsciiOptions = {
  /** Ordered dark to light. Default ' .:-=+*#%@', matching spec exactly. */
  charset?: string
  /** Cell size, px. Default 10, matching spec exactly. */
  cell?: number
}

const DEFAULT_CHARSET = ' .:-=+*#%@'

type Uploadable = HTMLImageElement | HTMLVideoElement

function isUploadableSource(target: Element): target is Uploadable {
  return target instanceof HTMLImageElement || target instanceof HTMLVideoElement
}

function uploadAtlasTexture(gl: WebGL2RenderingContext, atlas: { width: number; height: number; pixels: Uint8Array }): WebGLTexture | null {
  const texture = gl.createTexture()
  if (!texture) return null
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, atlas.width, atlas.height, 0, gl.RED, gl.UNSIGNED_BYTE, atlas.pixels)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.bindTexture(gl.TEXTURE_2D, null)
  return texture
}

export function ascii(options: AsciiOptions = {}): ComicePlugin {
  const { charset = DEFAULT_CHARSET, cell = 10 } = options

  if (charset.length === 0) {
    throw new Error('[comice] ascii(): `charset` must not be empty.')
  }

  let target: Uploadable | null = null
  let glContext: GLContext | null = null
  let plane: Plane | null = null
  let asciiProgram: AsciiProgram | null = null
  let atlasTexture: WebGLTexture | null = null
  let unregisterFromScheduler: (() => void) | null = null
  let resizeObserver: ResizeObserver | null = null
  let originalVisibility = ''
  let destroyed = false
  let cellSize = cell

  function renderFrame(): void {
    if (destroyed || !glContext || !plane || !asciiProgram) return
    glContext.resizeToDisplay()

    const cssWidth = glContext.canvas.clientWidth || 1
    const cssHeight = glContext.canvas.clientHeight || 1

    getResidencyPool(glContext).beginPass()
    drawAscii(glContext, asciiProgram, plane, atlasTexture, {
      resolutionWidth: cssWidth,
      resolutionHeight: cssHeight,
      cell: cellSize,
    })
  }

  return {
    name: 'ascii',

    setup(rawTarget: Element, _instance: ComiceInstance) {
      if (!isUploadableSource(rawTarget)) {
        throw new Error('[comice] ascii() requires an <img> or <video> target.')
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

      if (glContext) {
        asciiProgram = compileAsciiProgram(glContext.gl, { glyphCount: Array.from(charset).length })
        const atlas = buildGlyphAtlas(charset)
        if (atlas) {
          atlasTexture = uploadAtlasTexture(glContext.gl, atlas)
        }
        // Degrade-never-disappear: a null atlas (no 2D canvas available)
        // leaves atlasTexture null — drawAscii()'s own guard no-ops
        // rather than throwing, same fallback class as every other
        // primitive's failed-rasterization path.
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
      if (glContext && asciiProgram) destroyAsciiProgram(glContext.gl, asciiProgram)
      if (glContext && atlasTexture) glContext.gl.deleteTexture(atlasTexture)
      plane?.destroy()
      glContext?.canvas.remove()
      if (target) target.style.visibility = originalVisibility
      target = null
      glContext = null
      plane = null
      asciiProgram = null
      atlasTexture = null
      resizeObserver = null
    },

    // MappableTarget: `cell` is ascii's one live-mappable parameter, same
    // reasoning as mosaic's own — a scroll-driven ascii resolve that
    // coarsens/refines cell size as an element crosses a threshold.
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
