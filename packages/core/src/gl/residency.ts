/**
 * comice/core/gl/residency
 * ─────────────────────────────────────────────────────────────────────────────
 * T2 (ROADMAP.md §4): multi-texture residency. Spec §07: "Two or more
 * sources on the card at once, addressable in the same pass. This is the
 * precondition for every A to B transition, dissolve's whole job, and for
 * particles reassembling into a different image than it scattered from...
 * made explicit here because it constrains texture-unit budgeting on
 * mobile."
 *
 * This file is that budgeting. It does not draw anything and does not know
 * what a plugin is — it answers exactly two questions a multi-texture
 * consumer (dissolve, particles A→B, and eventually the mask field's
 * derived-mask reduction passes) needs answered honestly:
 *
 *   1. How many texture units can this context actually use right now?
 *   2. Given N textures this pass wants resident, which units do they go
 *      in, and what happens when N exceeds the budget?
 *
 * Also folds in the §13 mobile DPR cap (1.5–2x, not native device pixel
 * ratio) that T1 shipped without — see ROADMAP.md's T1 entry for why that
 * was deliberately deferred to land here: unit budgeting and the DPR cap
 * are the same "how much GPU memory is this page actually allowed to use"
 * conversation, and belong in one place rather than the cap being bolted
 * onto plane.ts after the fact.
 */

import type { GLContext } from './context.js'
export { effectiveDPR } from './context.js'

/** A conservative floor under WebGL2's guaranteed minimum
 *  (MAX_TEXTURE_IMAGE_UNITS is required to be >= 16 by the spec), used only
 *  if `gl.getParameter` itself is unavailable or misbehaves — belt and
 *  suspenders, not the expected path on a real WebGL2 context. */
const GUARANTEED_MIN_TEXTURE_UNITS = 16

/**
 * §13's "cap the pass chain" applied to texture units specifically:
 * mobile GPUs report high unit counts but the sane operating budget for a
 * media-interaction library (not a game engine) is much lower than the
 * hardware ceiling — leaving headroom for whatever else the page's
 * fragment shaders are doing this pass (multiple planes, a mask lookup,
 * a displacement map). This is a working ceiling, not a hardware query.
 */
const MAX_UNITS_TO_USE = 8

/** A residency pool: tracks which texture unit each currently-resident
 *  texture occupies, for one GLContext. One pool per context — created
 *  once, reused by every multi-texture consumer registered against that
 *  context, matching the "one thing allocated once" discipline the rest
 *  of this package holds to. */
export type ResidencyPool = {
  /** The number of texture units this pool will actually hand out —
   *  min(hardware reported units, MAX_UNITS_TO_USE). */
  readonly capacity: number
  /**
   * Binds `texture` into a texture unit for this pass and returns the
   * unit index (0-based) a shader's `sampler2D` uniform should be pointed
   * at via `gl.uniform1i(loc, unit)`. Reusing the same texture within the
   * same `beginPass()`/`endPass()` bracket returns the same unit without a
   * redundant `gl.activeTexture`/`gl.bindTexture` call.
   *
   * Returns null, never throws, if every unit in `capacity` is already
   * resident this pass — degrade-never-disappear applied to the budget
   * itself: a caller that hits the ceiling drops the lowest-priority
   * texture from this draw (or splits it across two passes) rather than
   * the pool silently exceeding hardware limits and corrupting another
   * texture's binding.
   */
  bind(texture: WebGLTexture): number | null
  /** Starts a new pass — clears which units are considered occupied so
   *  the next draw call's bind() calls start from unit 0 again. Call once
   *  per frame/pass, not per plane; a pass drawing three planes calls
   *  bind() three times between one beginPass()/endPass() pair. */
  beginPass(): void
  /** How many units are currently bound within the open pass. */
  readonly residentCount: number
}

const poolsByGL = new WeakMap<WebGL2RenderingContext, ResidencyPool>()

function queryMaxTextureUnits(gl: WebGL2RenderingContext): number {
  const reported = gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS)
  if (typeof reported !== 'number' || !Number.isFinite(reported) || reported <= 0) {
    return GUARANTEED_MIN_TEXTURE_UNITS
  }
  return reported
}

/**
 * Returns (creating once, per-context) the ResidencyPool for `context`.
 * Same reuse pattern as plane.ts's getPassThroughProgram — one pool per
 * GLContext, shared by every consumer that needs multiple textures
 * resident in one pass, not one pool per plugin instance.
 */
export function getResidencyPool(context: GLContext): ResidencyPool {
  const cached = poolsByGL.get(context.gl)
  if (cached) return cached

  const { gl } = context
  const capacity = Math.min(queryMaxTextureUnits(gl), MAX_UNITS_TO_USE)

  // unit -> texture currently bound there, for the OPEN pass only. Reset
  // by beginPass(). A Map (not an array) because lookups go texture ->
  // unit (has this texture already been bound this pass?), and arrays of
  // WebGLTexture identity don't index cleanly.
  const textureToUnit = new Map<WebGLTexture, number>()
  let nextFreeUnit = 0

  const pool: ResidencyPool = {
    capacity,

    beginPass(): void {
      textureToUnit.clear()
      nextFreeUnit = 0
    },

    get residentCount() {
      return textureToUnit.size
    },

    bind(texture: WebGLTexture): number | null {
      const existingUnit = textureToUnit.get(texture)
      if (existingUnit !== undefined) return existingUnit

      if (nextFreeUnit >= capacity) return null // budget exhausted this pass

      const unit = nextFreeUnit
      nextFreeUnit += 1
      gl.activeTexture(gl.TEXTURE0 + unit)
      gl.bindTexture(gl.TEXTURE_2D, texture)
      textureToUnit.set(texture, unit)
      return unit
    },
  }

  poolsByGL.set(gl, pool)
  return pool
}
