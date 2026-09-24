/**
 * @comice/ascii/shader
 * ─────────────────────────────────────────────────────────────────────────────
 * T10 (ROADMAP.md §4): spec §08's `ascii` card — "Owns: media rebuilt from
 * characters, live, on the GPU. Kept separate from mosaic because the
 * result reads as text, not as a degraded photograph."
 *
 * SDF GLYPH ATLAS, NOT A FONT TEXTURE: each character in `charset` is
 * rendered once, at setup(), to a signed-distance-field cell in a shared
 * atlas texture (index.ts's job — see atlas.ts), then this shader samples
 * that atlas per screen cell, picking whichever glyph's own DENSITY
 * (spec's own "ordered dark to light" charset convention — `' .:-=+*#%@'`
 * by default, the standard ASCII-art density ramp) best matches that
 * cell's sampled luminance from the real media texture. An SDF atlas
 * (rather than plain alpha-coverage glyphs) is what keeps character edges
 * crisp at any `cell` size without re-rasterizing per frame — the exact
 * same reasoning `gl/mask.ts`'s `rasterize(..., { sdf: true })` bake
 * uses for shape masks, applied here to glyphs instead.
 *
 * "NOT SELECTABLE TEXT OUTPUT," PER SPEC'S OWN EXCLUDES: every character
 * drawn here is a GPU-rasterized glyph shape from the SDF atlas, not a
 * DOM text node — there is nothing to select, matching the card's own
 * "If it must be readable by a screen reader, that text belongs in the
 * DOM layer underneath" line. This file draws pixels, never touches the
 * DOM at all.
 */

import { getResidencyPool } from 'comice/gl'
import type { GLContext, Plane } from 'comice/gl'

export type AsciiShaderOptions = {
  /** How many glyphs are packed into the atlas — the shader needs this to
   *  compute per-glyph UV slices. Matches `charset.length` exactly;
   *  index.ts computes it from the real charset string. */
  glyphCount: number
}

const VERTEX_SHADER = `#version 300 es
in vec2 a_position;
in vec2 a_uv;
out vec2 v_uv;

void main() {
  v_uv = a_uv;
  gl_Position = vec4(a_position, 0.0, 1.0);
}`

/**
 * Builds the fragment shader. Each screen cell:
 *   1. samples the media texture's average luminance for that cell,
 *   2. maps luminance -> a glyph index in [0, glyphCount) — DARKER pixels
 *      map toward the END of charset (spec's own convention: charset is
 *      "ordered dark to light", so index 0 is the densest glyph and a
 *      LOW luminance should pick a HIGH-density glyph, i.e. a LOW index —
 *      the mapping below is `glyphCount - 1 - bucket` for exactly this
 *      reason, not a naive direct luminance->index map),
 *   3. samples the SDF atlas at that glyph's own UV slice, using the
 *      cell-local UV (not the whole-screen UV) so the glyph shape repeats
 *      once per cell,
 *   4. thresholds the SDF sample to a hard glyph/background split, tinted
 *      by the ORIGINAL media color at that cell (so ascii output stays a
 *      full-color reconstruction, not monochrome ASCII art).
 */
export function buildFragmentShader(options: AsciiShaderOptions): string {
  const glyphCount = Math.max(1, options.glyphCount)
  return `#version 300 es
precision mediump float;

uniform sampler2D u_media;
uniform sampler2D u_atlas;
uniform vec2 u_resolution;
uniform float u_cell;

in vec2 v_uv;
out vec4 outColor;

void main() {
  vec2 cellIndex = floor(gl_FragCoord.xy / u_cell);
  vec2 cellCenterUv = (cellIndex * u_cell + u_cell * 0.5) / u_resolution;
  vec4 mediaColor = texture(u_media, clamp(cellCenterUv, 0.0, 1.0));
  float luma = dot(mediaColor.rgb, vec3(0.2126, 0.7152, 0.0722));

  int glyphCount = ${glyphCount};
  int bucket = int(clamp(luma * float(glyphCount), 0.0, float(glyphCount - 1)));
  // charset is dark->light; a LOW luminance should land on charset's
  // DENSEST (first) glyph, so the bucket is inverted here.
  int glyphIndex = glyphCount - 1 - bucket;

  vec2 cellLocalUv = fract(gl_FragCoord.xy / u_cell);
  float atlasStep = 1.0 / float(glyphCount);
  vec2 atlasUv = vec2((float(glyphIndex) + cellLocalUv.x) * atlasStep, cellLocalUv.y);

  float sdf = texture(u_atlas, atlasUv).r;
  float glyphMask = smoothstep(0.45, 0.55, sdf);

  outColor = vec4(mediaColor.rgb * glyphMask, 1.0);
}`
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type)
  if (!shader) return null
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader)
    return null
  }
  return shader
}

export type AsciiProgram = {
  program: WebGLProgram
  vao: WebGLVertexArrayObject
  uMedia: WebGLUniformLocation | null
  uAtlas: WebGLUniformLocation | null
  uResolution: WebGLUniformLocation | null
  uCell: WebGLUniformLocation | null
}

const PROGRAM_CACHE = new WeakMap<WebGL2RenderingContext, Map<number, AsciiProgram | null>>()
// A real bug found running many ascii() instances on one real page (hover
// swapping ascii()/mosaic() across grid cards): two instances compiling the
// same glyphCount share ONE cached program, so the first instance to tear
// down must not delete it out from under the still-live second instance.
const REFCOUNTS = new WeakMap<WebGL2RenderingContext, Map<number, number>>()

export function compileAsciiProgram(gl: WebGL2RenderingContext, options: AsciiShaderOptions): AsciiProgram | null {
  let byGlyphCount = PROGRAM_CACHE.get(gl)
  if (!byGlyphCount) {
    byGlyphCount = new Map()
    PROGRAM_CACHE.set(gl, byGlyphCount)
  }
  let refcounts = REFCOUNTS.get(gl)
  if (!refcounts) {
    refcounts = new Map()
    REFCOUNTS.set(gl, refcounts)
  }
  const key = Math.max(1, options.glyphCount)
  const cached = byGlyphCount.get(key)
  if (cached !== undefined) {
    if (cached !== null) refcounts.set(key, (refcounts.get(key) ?? 0) + 1)
    return cached
  }

  const fragmentSource = buildFragmentShader(options)
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER)
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource)
  if (!vertexShader || !fragmentShader) {
    byGlyphCount.set(key, null)
    return null
  }

  const program = gl.createProgram()
  if (!program) {
    byGlyphCount.set(key, null)
    return null
  }
  gl.attachShader(program, vertexShader)
  gl.attachShader(program, fragmentShader)
  gl.linkProgram(program)
  gl.deleteShader(vertexShader)
  gl.deleteShader(fragmentShader)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program)
    byGlyphCount.set(key, null)
    return null
  }

  const vao = gl.createVertexArray()
  gl.bindVertexArray(vao)
  const buffer = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  // prettier-ignore
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([
      -1, -1, 0, 0,
       1, -1, 1, 0,
      -1,  1, 0, 1,
       1,  1, 1, 1,
    ]),
    gl.STATIC_DRAW,
  )
  const aPosition = gl.getAttribLocation(program, 'a_position')
  const aUv = gl.getAttribLocation(program, 'a_uv')
  const stride = 4 * Float32Array.BYTES_PER_ELEMENT
  gl.enableVertexAttribArray(aPosition)
  gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, stride, 0)
  gl.enableVertexAttribArray(aUv)
  gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, stride, 2 * Float32Array.BYTES_PER_ELEMENT)
  gl.bindVertexArray(null)

  const result: AsciiProgram = {
    program,
    vao,
    uMedia: gl.getUniformLocation(program, 'u_media'),
    uAtlas: gl.getUniformLocation(program, 'u_atlas'),
    uResolution: gl.getUniformLocation(program, 'u_resolution'),
    uCell: gl.getUniformLocation(program, 'u_cell'),
  }
  byGlyphCount.set(key, result)
  refcounts.set(key, 1) // this compile call is itself the first live reference
  return result
}

export function destroyAsciiProgram(gl: WebGL2RenderingContext, asciiProgram: AsciiProgram): void {
  const byGlyphCount = PROGRAM_CACHE.get(gl)
  const refcounts = REFCOUNTS.get(gl)
  const key = byGlyphCount ? [...byGlyphCount.entries()].find(([, program]) => program === asciiProgram)?.[0] : undefined

  if (key !== undefined && refcounts) {
    const remaining = (refcounts.get(key) ?? 1) - 1
    if (remaining > 0) {
      refcounts.set(key, remaining)
      return // other instances still hold this program — do not delete it
    }
    refcounts.delete(key)
    byGlyphCount?.delete(key)
  }

  gl.deleteProgram(asciiProgram.program)
  gl.deleteVertexArray(asciiProgram.vao)
}

export type AsciiDrawState = {
  resolutionWidth: number
  resolutionHeight: number
  cell: number
}

/**
 * Draws one ascii pass. Binds the media texture AND the glyph atlas
 * texture through the shared ResidencyPool. Assumes the caller already
 * called beginPass() this frame.
 *
 * Returns without drawing, never throwing, if the media plane has no
 * texture yet, the atlas texture is null (not yet rasterized), or the
 * residency pool's unit budget is exhausted.
 */
export function drawAscii(context: GLContext, asciiProgram: AsciiProgram, mediaPlane: Plane, atlasTexture: WebGLTexture | null, state: AsciiDrawState): void {
  if (!mediaPlane.texture || !atlasTexture) return

  const pool = getResidencyPool(context)
  const mediaUnit = pool.bind(mediaPlane.texture)
  if (mediaUnit === null) return
  const atlasUnit = pool.bind(atlasTexture)
  if (atlasUnit === null) return

  const { gl } = context
  gl.useProgram(asciiProgram.program)
  gl.bindVertexArray(asciiProgram.vao)

  gl.uniform1i(asciiProgram.uMedia, mediaUnit)
  gl.uniform1i(asciiProgram.uAtlas, atlasUnit)
  gl.uniform2f(asciiProgram.uResolution, state.resolutionWidth, state.resolutionHeight)
  gl.uniform1f(asciiProgram.uCell, Math.max(1, state.cell))

  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

  gl.bindVertexArray(null)
}
