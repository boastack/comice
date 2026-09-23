/**
 * @comice/dissolve/shader
 * ─────────────────────────────────────────────────────────────────────────────
 * T8 (ROADMAP.md §4): the first real exercise of two of the four §07
 * primitives — T2 (multi-texture residency, for real A→B blending between
 * two DIFFERENT sources, not morph's single-media-plus-mask case) and T5
 * (gl/noise.ts's simplex noise + displacement sampler, spliced into a real
 * shader for the first time anywhere in this codebase).
 *
 * Spec §08's `dissolve` card: "Owns: moving between two pieces of media
 * that are both resident at once." Eleven transitions listed on the card;
 * this pass scopes to three — `crossfade`, `noise`, `liquid` — the three
 * spec's own text singles out for explanation ("Why noise matters... noise
 * controls the threshold instead... liquid adds displacement on top of
 * that so image A appears to flow into B rather than fade"), and together
 * they prove the general pattern (plain blend → threshold-driven blend →
 * displaced blend) the remaining eight transitions extend rather than
 * reinvent. `displace`/`wipe`/`zoomBlur`/`pixelBridge`/`ink`/`flip`/
 * `glitch`/`mask`/`dissolve` are a follow-up, same "prove the pattern,
 * expand later" precedent `morph`'s layouts and operations both used.
 *
 * NO LEGACY REFERENCE — `dissolve` (as `blend` in legacy's own naming
 * history, per spec §08's "Was" column) has no working implementation in
 * `legacy/`. This shader is designed from spec §07/§08's own text, not
 * ported. `gl/noise.ts`'s own header already anticipated this exact
 * moment: "dissolve's noise and liquid transitions... are the same math
 * pointed at different targets" as `distort`'s liquid/glass — this file
 * and packages/distort/src/shader.ts both splice in the SAME
 * composeNoiseGLSL() output, not two copies.
 */

import { getResidencyPool } from 'comice/gl'
import { composeNoiseGLSL } from 'comice/gl'
import type { GLContext, Plane } from 'comice/gl'

export type DissolveTransition = 'crossfade' | 'noise' | 'liquid'

export type NoiseOptions = {
  /** Spatial frequency of the noise field. Higher values read as finer
   *  grain. Matches spec §08's `noise.scale` exactly. Default 3. */
  scale?: number
  /** How strongly the noise perturbs the transition threshold
   *  (`noise`/`dissolve`) or displaces sampling (`liquid`). Matches spec
   *  §08's `noise.intensity`. Default 1. */
  intensity?: number
  /** Softness of the per-pixel crossover edge, 0..1 — 0 is a hard cutover
   *  the instant a pixel's noise value crosses the threshold, larger
   *  values blend over a wider band. Matches spec §08's `noise.softness`.
   *  Default 0.15. */
  softness?: number
}

export type DissolveShaderOptions = {
  transition: DissolveTransition
  noise?: NoiseOptions
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
 * Builds the fragment shader for one DissolveShaderOptions configuration.
 * Unlike morph.ts's shader (its own aspect-normalized `st` space, no
 * per-plane positioning), dissolve samples both textures at the SAME UV —
 * both `from` and `to` are expected to already cover the same on-screen
 * box (the plugin's target element), so there is no separate cover-scale
 * step per source the way morph handles one arbitrary-aspect media
 * texture; a future transition that needs independent from/to framing
 * (crop/cover differences) is out of this pass's scope.
 */
function buildFragmentShader(options: DissolveShaderOptions): string {
  const { transition, noise } = options
  const scale = noise?.scale ?? 3
  const intensity = noise?.intensity ?? 1
  const softness = Math.max(0.001, Math.min(1, noise?.softness ?? 0.15))

  const needsNoise = transition === 'noise' || transition === 'liquid'
  const noiseGLSL = needsNoise ? composeNoiseGLSL({ curl: false, displacement: transition === 'liquid' }) : ''

  // blendGLSL: the one thing that differs per transition — everything
  // else (uniform declarations, both texture samples, output) is shared.
  const blendGLSL =
    transition === 'crossfade'
      ? `
  vec4 fromColor = texture(u_from, v_uv);
  vec4 toColor = texture(u_to, v_uv);
  outColor = mix(fromColor, toColor, p);`
      : transition === 'noise'
        ? `
  // Per-pixel CROSSING POINT drawn from simplex noise, NOT a plain lerp —
  // this is spec §08's own "why noise matters": a crossfade moves every
  // pixel at the same rate, which is the one thing a real material never
  // does. Each pixel gets its own threshold in [0,1] (n01 below); as p
  // sweeps 0->1, a pixel flips from 'from' to 'to' once p passes ITS OWN
  // threshold, with a soft smoothstep band of width softness around the
  // crossing — so p=0 reads as all-from, p=1 reads as all-to, and every
  // point in between is a genuinely different per-pixel mix, not a
  // uniform-everywhere blend. intensity scales how far n01 spreads from
  // the neutral 0.5 (a plain crossfade sweep) toward the full [0,1] range.
  float n = simplexNoise(vec3(v_uv * ${scale.toFixed(6)}, 0.0));
  float n01 = 0.5 + 0.5 * n * ${intensity.toFixed(6)};
  float localP = smoothstep(n01 - ${softness.toFixed(6)}, n01 + ${softness.toFixed(6)}, p);
  vec4 fromColor = texture(u_from, v_uv);
  vec4 toColor = texture(u_to, v_uv);
  outColor = mix(fromColor, toColor, localP);`
        : `
  // liquid: the same per-pixel noise-driven crossing point as 'noise'
  // (see that branch's own comment), PLUS a displacement pass on the
  // sampling UV itself (via gl/noise.ts's displacementOffset(), the
  // shared sampler spec §07 explicitly calls out as common between
  // dissolve's liquid transition and distort's liquid/glass presets) —
  // so image A reads as FLOWING into B, not just fading through a torn
  // edge.
  vec2 flow = displacementOffset(v_uv, p, ${(intensity * 0.05).toFixed(6)});
  vec2 fromUv = clamp(v_uv - flow * (1.0 - p), 0.0, 1.0);
  vec2 toUv = clamp(v_uv + flow * p, 0.0, 1.0);
  float n = simplexNoise(vec3(v_uv * ${scale.toFixed(6)}, p * 2.0));
  float n01 = 0.5 + 0.5 * n * ${intensity.toFixed(6)};
  float localP = smoothstep(n01 - ${softness.toFixed(6)}, n01 + ${softness.toFixed(6)}, p);
  vec4 fromColor = texture(u_from, fromUv);
  vec4 toColor = texture(u_to, toUv);
  outColor = mix(fromColor, toColor, localP);`

  return `#version 300 es
precision mediump float;

uniform float u_progress;
uniform sampler2D u_from;
uniform sampler2D u_to;

in vec2 v_uv;
out vec4 outColor;

${noiseGLSL}

void main() {
  float p = clamp(u_progress, 0.0, 1.0);
  ${blendGLSL}
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

export type DissolveProgram = {
  program: WebGLProgram
  vao: WebGLVertexArrayObject
  uProgress: WebGLUniformLocation | null
  uFrom: WebGLUniformLocation | null
  uTo: WebGLUniformLocation | null
}

/**
 * Compiles a DissolveProgram for `options`. Program cache keyed by
 * `(transition, scale, intensity, softness)`, same reasoning as
 * morph.ts's own cache: two dissolve instances legitimately want
 * different compiled shaders on one page (a crossfade gallery next to a
 * liquid hero), so this is per-context but per-configuration, not a
 * single program per context.
 */
const PROGRAM_CACHE = new WeakMap<WebGL2RenderingContext, Map<string, DissolveProgram | null>>()

function cacheKey(options: DissolveShaderOptions): string {
  const { transition, noise } = options
  return `${transition}:${noise?.scale ?? 3}:${noise?.intensity ?? 1}:${noise?.softness ?? 0.15}`
}

export function compileDissolveProgram(gl: WebGL2RenderingContext, options: DissolveShaderOptions): DissolveProgram | null {
  let byConfig = PROGRAM_CACHE.get(gl)
  if (!byConfig) {
    byConfig = new Map()
    PROGRAM_CACHE.set(gl, byConfig)
  }
  const key = cacheKey(options)
  const cached = byConfig.get(key)
  if (cached !== undefined) return cached

  const fragmentSource = buildFragmentShader(options)
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER)
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource)
  if (!vertexShader || !fragmentShader) {
    byConfig.set(key, null)
    return null
  }

  const program = gl.createProgram()
  if (!program) {
    byConfig.set(key, null)
    return null
  }
  gl.attachShader(program, vertexShader)
  gl.attachShader(program, fragmentShader)
  gl.linkProgram(program)
  gl.deleteShader(vertexShader)
  gl.deleteShader(fragmentShader)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program)
    byConfig.set(key, null)
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

  const result: DissolveProgram = {
    program,
    vao,
    uProgress: gl.getUniformLocation(program, 'u_progress'),
    uFrom: gl.getUniformLocation(program, 'u_from'),
    uTo: gl.getUniformLocation(program, 'u_to'),
  }
  byConfig.set(key, result)
  return result
}

export function destroyDissolveProgram(gl: WebGL2RenderingContext, dissolveProgram: DissolveProgram): void {
  gl.deleteProgram(dissolveProgram.program)
  gl.deleteVertexArray(dissolveProgram.vao)
}

export type DissolveDrawState = {
  progress: number
}

/**
 * Draws one dissolve pass — binds BOTH `fromPlane` and `toPlane`'s
 * textures through the shared ResidencyPool in the SAME pass, the actual
 * point of T2 (multi-texture residency): "two or more sources on the
 * card at once, addressable in the same pass," spec §07's own words,
 * exercised here for real for the first time with two genuinely
 * different media sources (morph's own residency use only ever bound one
 * media texture plus one mask texture, never two independent media
 * sources).
 *
 * Assumes the caller has already called the residency pool's
 * `beginPass()` for this frame, matching morph's drawMorph() /
 * gl/plane.ts's drawPlane() convention exactly — this function does not
 * call beginPass() itself.
 *
 * Returns without drawing, never throwing, if either plane has no
 * texture yet (media hasn't decoded), or if the residency pool's unit
 * budget is exhausted before both textures get a unit.
 */
export function drawDissolve(context: GLContext, dissolveProgram: DissolveProgram, fromPlane: Plane, toPlane: Plane, state: DissolveDrawState): void {
  if (!fromPlane.texture || !toPlane.texture) return

  const pool = getResidencyPool(context)
  const fromUnit = pool.bind(fromPlane.texture)
  if (fromUnit === null) return
  const toUnit = pool.bind(toPlane.texture)
  if (toUnit === null) return

  const { gl } = context
  gl.useProgram(dissolveProgram.program)
  gl.bindVertexArray(dissolveProgram.vao)

  gl.uniform1f(dissolveProgram.uProgress, state.progress)
  gl.uniform1i(dissolveProgram.uFrom, fromUnit)
  gl.uniform1i(dissolveProgram.uTo, toUnit)

  gl.enable(gl.BLEND)
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

  gl.bindVertexArray(null)
}
