/**
 * @comice/color/shader
 * ─────────────────────────────────────────────────────────────────────────────
 * T9 (ROADMAP.md §4): spec §08's `color` card — "Owns: how media is graded,
 * stylised and physically finished." Six effects on the card: `duotone`,
 * `lut`, `grain`, `bloom`, `aberration`, `dof`. Five ship this pass —
 * `duotone`, `lut`, `grain`, `bloom`, `aberration`. `dof` (depth of field)
 * is deliberately NOT implemented: it needs a real depth map, which is
 * `vision`'s job (Phase 4, not built), and spec's own `vision` card is
 * explicit that masking/depth-consuming decisions belong to the consumer,
 * not to vision itself producing a fake depth signal — there's no honest
 * fallback here the way, say, dissolve's `mask` transition still had a
 * usable path without `vision`. Faking DOF off a synthetic gradient
 * instead of real depth would ship something that looks like a feature but
 * silently lies about what it's doing, which every plugin in this repo so
 * far has refused to do (see distort's own "no fake pointer" exclusion).
 *
 * ALL FIVE SHIPPED EFFECTS ARE COMPOSABLE, NOT MUTUALLY EXCLUSIVE — unlike
 * dissolve's `transition` or distort's `effect` (exactly one active at a
 * time), spec's own card lists color's effects as a plain chip row with no
 * "Default" column, and the natural real-world use (grain over a duotone
 * grade, bloom AND aberration on the same shot) is a stack, not a choice.
 * `buildFragmentShader()` therefore takes a set of enabled effects and
 * applies them in a fixed pipeline order — duotone/lut (color remap) →
 * bloom (adds light) → aberration (splits channels) → grain (adds noise
 * last, over the final composited image, matching how film grain is the
 * outermost layer of a real photochemical or digital pipeline).
 *
 * LUT FORMAT: a real .cube file (spec's own words: "the format colourists
 * already use") is a text 3D lookup table — parsing one is real, separate
 * work (index.ts's job, see lut.ts), not this shader's. This file only
 * knows how to SAMPLE an already-uploaded LUT 3D-texture-as-2D-strip (the
 * standard trick for sampling a cube LUT in WebGL2 without 3D textures,
 * since a 3D texture upload from a parsed .cube array is a much heavier
 * path than encoding the same data as a tiled 2D texture and doing the
 * blue-axis tiling lookup in-shader).
 */

import { getResidencyPool } from 'comice/gl'
import type { GLContext, Plane } from 'comice/gl'

export type ColorEffect = 'duotone' | 'lut' | 'grain' | 'bloom' | 'aberration'

export type DuotoneOptions = {
  /** Shadow color, [r, g, b] 0..1. Default a near-black [0.05, 0.05, 0.1]. */
  shadow?: readonly [number, number, number]
  /** Highlight color, [r, g, b] 0..1. Default a warm white [1, 0.96, 0.9]. */
  highlight?: readonly [number, number, number]
}

export type LutOptions = {
  /** The LUT's cube size (a 33-entry .cube file is `size: 33`). Required
   *  when `lut` is enabled — the shader needs this to compute the tiled
   *  2D-strip lookup coordinates correctly. */
  size: number
}

export type GrainOptions = {
  /** Grain intensity, 0..1. Default 0.08. */
  amount?: number
}

export type BloomOptions = {
  /** Luminance above which a pixel contributes to the glow. Default 0.7. */
  threshold?: number
  /** Glow strength. Default 0.6. */
  intensity?: number
}

export type AberrationOptions = {
  /** Channel-split distance, in UV units, scaling outward from center. Default 0.004. */
  amount?: number
}

export type ColorShaderOptions = {
  effects: readonly ColorEffect[]
  interpolate?: 'oklch' | 'rgb'
  duotone?: DuotoneOptions
  lut?: LutOptions
  grain?: GrainOptions
  bloom?: BloomOptions
  aberration?: AberrationOptions
}

const VERTEX_SHADER = `#version 300 es
in vec2 a_position;
in vec2 a_uv;
out vec2 v_uv;

void main() {
  v_uv = a_uv;
  gl_Position = vec4(a_position, 0.0, 1.0);
}`

// OKLCH round-trip via the standard OKLab matrices — spec §10's own "OKLCH
// by default" for color blending. Used only by duotone's shadow<->highlight
// interpolation when `interpolate: 'oklch'`; 'rgb' skips this entirely.
const OKLAB_GLSL = `
vec3 linearToOklab(vec3 c) {
  float l = 0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b;
  float m = 0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b;
  float s = 0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b;
  float l_ = pow(max(l, 0.0), 1.0 / 3.0);
  float m_ = pow(max(m, 0.0), 1.0 / 3.0);
  float s_ = pow(max(s, 0.0), 1.0 / 3.0);
  return vec3(
    0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_
  );
}
vec3 oklabToLinear(vec3 c) {
  float l_ = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
  float m_ = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
  float s_ = c.x - 0.0894841775 * c.y - 1.2914855480 * c.z;
  float l = l_ * l_ * l_;
  float m = m_ * m_ * m_;
  float s = s_ * s_ * s_;
  return vec3(
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
  );
}
vec3 mixColor(vec3 a, vec3 b, float t, bool useOklab) {
  if (useOklab) {
    return oklabToLinear(mix(linearToOklab(a), linearToOklab(b), t));
  }
  return mix(a, b, t);
}`

// A cheap deterministic hash-noise, the same class of function used for
// procedural grain in every real-time renderer that doesn't want to
// upload a noise texture — no need for gl/noise.ts's simplex here, grain
// is meant to read as fine, uncorrelated per-pixel dither, not a smooth
// coherent field the way dissolve/distort's noise transitions are.
const HASH_GLSL = `
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453123);
}`

function buildDuotoneGLSL(options: DuotoneOptions | undefined, useOklab: boolean): string {
  const shadow = options?.shadow ?? [0.05, 0.05, 0.1]
  const highlight = options?.highlight ?? [1, 0.96, 0.9]
  return `
  {
    float luma = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));
    vec3 shadowColor = vec3(${shadow[0].toFixed(6)}, ${shadow[1].toFixed(6)}, ${shadow[2].toFixed(6)});
    vec3 highlightColor = vec3(${highlight[0].toFixed(6)}, ${highlight[1].toFixed(6)}, ${highlight[2].toFixed(6)});
    color.rgb = mixColor(shadowColor, highlightColor, luma, ${useOklab ? 'true' : 'false'});
  }`
}

function buildLutGLSL(lut: LutOptions): string {
  // Standard 2D-strip cube-LUT sampling: the LUT texture is `size * size`
  // wide (size tiles, each size x size) and `size` tall. Blue selects
  // which tile; red/green address within it. index.ts is responsible for
  // uploading the LUT in exactly this layout (see lut.ts).
  const size = Math.max(2, Math.round(lut.size))
  return `
  {
    float lutSize = ${size.toFixed(1)};
    float blueIndex = clamp(color.b, 0.0, 1.0) * (lutSize - 1.0);
    float tileLow = floor(blueIndex);
    float tileHigh = min(tileLow + 1.0, lutSize - 1.0);
    float tileFrac = blueIndex - tileLow;

    vec2 rg = clamp(color.rg, 0.0, 1.0) * (lutSize - 1.0) + 0.5;
    vec2 uvLow = vec2((tileLow * lutSize + rg.x) / (lutSize * lutSize), rg.y / lutSize);
    vec2 uvHigh = vec2((tileHigh * lutSize + rg.x) / (lutSize * lutSize), rg.y / lutSize);

    vec3 lutLow = texture(u_lut, uvLow).rgb;
    vec3 lutHigh = texture(u_lut, uvHigh).rgb;
    color.rgb = mix(lutLow, lutHigh, tileFrac);
  }`
}

function buildBloomGLSL(): string {
  // A cheap single-pass approximate bloom: sample a small ring around the
  // current pixel, keep only the bright contributors (above u_bloomThreshold),
  // and add their average scaled by u_bloomIntensity. A real multi-pass
  // blur/downsample bloom is a follow-up (see the file header) — this is
  // "the same idea, one pass," matching the honesty standard every other
  // shader in this repo holds to about what it actually computes.
  return `
  {
    vec3 glow = vec3(0.0);
    const int SAMPLES = 8;
    float radius = 0.006;
    for (int i = 0; i < SAMPLES; i++) {
      float angle = (float(i) / float(SAMPLES)) * 6.28318530718;
      vec2 offset = vec2(cos(angle), sin(angle)) * radius;
      vec3 sampleColor = texture(u_media, clamp(v_uv + offset, 0.0, 1.0)).rgb;
      float luma = dot(sampleColor, vec3(0.2126, 0.7152, 0.0722));
      glow += sampleColor * step(u_bloomThreshold, luma);
    }
    glow /= float(SAMPLES);
    color.rgb += glow * u_bloomIntensity;
  }`
}

function buildAberrationGLSL(): string {
  return `
  {
    vec2 center = vec2(0.5);
    vec2 dir = v_uv - center;
    vec2 offset = dir * u_aberrationAmount;
    float r = texture(u_media, clamp(v_uv - offset, 0.0, 1.0)).r;
    float g = color.g;
    float b = texture(u_media, clamp(v_uv + offset, 0.0, 1.0)).b;
    color.rgb = vec3(r, g, b);
  }`
}

function buildGrainGLSL(): string {
  return `
  {
    float n = hash(v_uv * u_resolution + u_grainSeed) - 0.5;
    color.rgb += n * u_grainAmount;
  }`
}

/**
 * Builds the fragment shader for one ColorShaderOptions configuration.
 * Samples the media once at v_uv (dissolve's own plain-UV convention, not
 * morph's aspect-corrected `st` space — color operates on the whole frame
 * uniformly, it never needs per-plane cover-scale math), then threads
 * `color` through each enabled effect in the fixed pipeline order the
 * file header documents.
 */
export function buildFragmentShader(options: ColorShaderOptions): string {
  const { effects, interpolate = 'oklch' } = options
  const useOklab = interpolate === 'oklch'
  const has = (e: ColorEffect): boolean => effects.includes(e)

  const chunks: string[] = []
  if (has('duotone')) chunks.push(buildDuotoneGLSL(options.duotone, useOklab))
  if (has('lut')) chunks.push(buildLutGLSL(options.lut ?? { size: 2 }))
  if (has('bloom')) chunks.push(buildBloomGLSL())
  if (has('aberration')) chunks.push(buildAberrationGLSL())
  if (has('grain')) chunks.push(buildGrainGLSL())

  return `#version 300 es
precision mediump float;

uniform sampler2D u_media;
uniform sampler2D u_lut;
uniform vec2 u_resolution;
uniform float u_bloomThreshold;
uniform float u_bloomIntensity;
uniform float u_aberrationAmount;
uniform float u_grainAmount;
uniform float u_grainSeed;
uniform float u_shift; // hue rotation, turns

in vec2 v_uv;
out vec4 outColor;

${OKLAB_GLSL}
${HASH_GLSL}

void main() {
  vec4 color = texture(u_media, v_uv);
  ${chunks.join('\n')}
  // shift: the hue turned around OKLab's a/b plane, after everything else
  // — lightness and chroma kept. Mappable (spec §04 maps audio into it).
  if (u_shift != 0.0) {
    vec3 lab = linearToOklab(color.rgb);
    float angle = u_shift * 6.28318530718;
    lab.yz = mat2(cos(angle), sin(angle), -sin(angle), cos(angle)) * lab.yz;
    color.rgb = clamp(oklabToLinear(lab), 0.0, 1.0);
  }
  outColor = color;
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

export type ColorProgram = {
  program: WebGLProgram
  vao: WebGLVertexArrayObject
  uMedia: WebGLUniformLocation | null
  uLut: WebGLUniformLocation | null
  uResolution: WebGLUniformLocation | null
  uBloomThreshold: WebGLUniformLocation | null
  uBloomIntensity: WebGLUniformLocation | null
  uAberrationAmount: WebGLUniformLocation | null
  uGrainAmount: WebGLUniformLocation | null
  uGrainSeed: WebGLUniformLocation | null
  uShift: WebGLUniformLocation | null
}

// Cached per-context, per-configuration — same reasoning as dissolve's/
// distort's own program cache: two color() instances on one page
// legitimately want different compiled effect stacks.
const PROGRAM_CACHE = new WeakMap<WebGL2RenderingContext, Map<string, ColorProgram | null>>()
// A real bug found running many color() instances on one real page
// (including the hero's own distort()+color() stack): two instances
// compiling the same config share ONE cached program, so the first
// instance to tear down must not delete it out from under a still-live
// second instance holding the same reference.
const REFCOUNTS = new WeakMap<WebGL2RenderingContext, Map<string, number>>()

function cacheKey(options: ColorShaderOptions): string {
  const { effects, interpolate = 'oklch', lut } = options
  return `${[...effects].sort().join(',')}:${interpolate}:${lut?.size ?? ''}`
}

export function compileColorProgram(gl: WebGL2RenderingContext, options: ColorShaderOptions): ColorProgram | null {
  let byConfig = PROGRAM_CACHE.get(gl)
  if (!byConfig) {
    byConfig = new Map()
    PROGRAM_CACHE.set(gl, byConfig)
  }
  let refcounts = REFCOUNTS.get(gl)
  if (!refcounts) {
    refcounts = new Map()
    REFCOUNTS.set(gl, refcounts)
  }
  const key = cacheKey(options)
  const cached = byConfig.get(key)
  if (cached !== undefined) {
    if (cached !== null) refcounts.set(key, (refcounts.get(key) ?? 0) + 1)
    return cached
  }

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

  const result: ColorProgram = {
    program,
    vao,
    uMedia: gl.getUniformLocation(program, 'u_media'),
    uLut: gl.getUniformLocation(program, 'u_lut'),
    uResolution: gl.getUniformLocation(program, 'u_resolution'),
    uBloomThreshold: gl.getUniformLocation(program, 'u_bloomThreshold'),
    uBloomIntensity: gl.getUniformLocation(program, 'u_bloomIntensity'),
    uAberrationAmount: gl.getUniformLocation(program, 'u_aberrationAmount'),
    uGrainAmount: gl.getUniformLocation(program, 'u_grainAmount'),
    uGrainSeed: gl.getUniformLocation(program, 'u_grainSeed'),
    uShift: gl.getUniformLocation(program, 'u_shift'),
  }
  byConfig.set(key, result)
  refcounts.set(key, 1) // this compile call is itself the first live reference
  return result
}

export function destroyColorProgram(gl: WebGL2RenderingContext, colorProgram: ColorProgram): void {
  const byConfig = PROGRAM_CACHE.get(gl)
  const refcounts = REFCOUNTS.get(gl)
  const key = byConfig ? [...byConfig.entries()].find(([, program]) => program === colorProgram)?.[0] : undefined

  if (key !== undefined && refcounts) {
    const remaining = (refcounts.get(key) ?? 1) - 1
    if (remaining > 0) {
      refcounts.set(key, remaining)
      return // other instances still hold this program — do not delete it
    }
    refcounts.delete(key)
    byConfig?.delete(key)
  }

  gl.deleteProgram(colorProgram.program)
  gl.deleteVertexArray(colorProgram.vao)
}

export type ColorDrawState = {
  resolutionWidth: number
  resolutionHeight: number
  bloomThreshold: number
  bloomIntensity: number
  aberrationAmount: number
  grainAmount: number
  grainSeed: number
  /** Hue rotation, in turns (0..1 is 0..360°). */
  shift?: number
}

/**
 * Draws one color pass. Binds the media texture (and the LUT texture, if
 * `lutTexture` is provided) through the shared ResidencyPool. Assumes the
 * caller already called beginPass() this frame — same convention every
 * other drawX() function in this repo holds to (see gl/plane.ts's own
 * drawPlane() doc comment, morph's/dissolve's/distort's own drawX()).
 *
 * Returns without drawing, never throwing, if the media plane has no
 * texture yet, or the residency pool's unit budget is exhausted.
 */
export function drawColor(context: GLContext, colorProgram: ColorProgram, mediaPlane: Plane, lutTexture: WebGLTexture | null, state: ColorDrawState): void {
  if (!mediaPlane.texture) return

  const pool = getResidencyPool(context)
  const mediaUnit = pool.bind(mediaPlane.texture)
  if (mediaUnit === null) return

  // The LUT texture is optional — a config with `lut` disabled never
  // reaches here with lutTexture set, but a config that enables `lut`
  // must have one uploaded before draw; if the residency pool can't fit
  // it (unlikely, one extra unit), the LUT sample simply reads whatever
  // unit 0 already has bound rather than throwing — degrade, don't crash.
  let lutUnit = 0
  if (lutTexture) {
    const bound = pool.bind(lutTexture)
    if (bound !== null) lutUnit = bound
  }

  const { gl } = context
  gl.useProgram(colorProgram.program)
  gl.bindVertexArray(colorProgram.vao)

  gl.uniform1i(colorProgram.uMedia, mediaUnit)
  gl.uniform1i(colorProgram.uLut, lutUnit)
  gl.uniform2f(colorProgram.uResolution, state.resolutionWidth, state.resolutionHeight)
  gl.uniform1f(colorProgram.uBloomThreshold, state.bloomThreshold)
  gl.uniform1f(colorProgram.uBloomIntensity, state.bloomIntensity)
  gl.uniform1f(colorProgram.uAberrationAmount, state.aberrationAmount)
  gl.uniform1f(colorProgram.uGrainAmount, state.grainAmount)
  gl.uniform1f(colorProgram.uGrainSeed, state.grainSeed)
  gl.uniform1f(colorProgram.uShift, state.shift ?? 0)

  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

  gl.bindVertexArray(null)
}
