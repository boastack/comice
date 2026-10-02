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

import { bindMaskUniforms, getResidencyPool, MASK_SAMPLE_GLSL, type MaskField } from 'comice/gl'
import { composeNoiseGLSL } from 'comice/gl'
import type { GLContext, Plane } from 'comice/gl'

export type DissolveTransition =
  | 'crossfade'
  | 'displace'
  | 'wipe'
  | 'zoomBlur'
  | 'pixelBridge'
  | 'ink'
  | 'flip'
  | 'glitch'
  | 'noise'
  | 'liquid'
  | 'mask'
  | 'dissolve'

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
  /** Degrees. Biases where the crossing starts, so it sweeps across the
   *  image in that direction (0 = left to right, 90 = bottom to top). For
   *  noise/liquid/dissolve, and the direction of 'wipe'. Default: no bias
   *  (noise), left to right (wipe). */
  direction?: number
  /** 0..1, where the median pixel crosses: lower crosses earlier. For
   *  noise/liquid/dissolve. Default 0.5. */
  threshold?: number
  /** Picks a different noise pattern. Default 0. */
  seed?: number
}

export type DissolveShaderOptions = {
  transition: DissolveTransition
  noise?: NoiseOptions
  /** 'displace' with a caller-supplied displacement texture (`map`). */
  hasMap?: boolean
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
  const { transition, noise, hasMap = false } = options
  const scale = (noise?.scale ?? 3).toFixed(6)
  const intensity = (noise?.intensity ?? 1).toFixed(6)
  const softness = Math.max(0.001, Math.min(1, noise?.softness ?? 0.15)).toFixed(6)
  const threshold = (noise?.threshold ?? 0.5).toFixed(6)
  const seed = (noise?.seed ?? 0).toFixed(6)
  const angle = ((noise?.direction ?? 0) * Math.PI) / 180
  const direction = `vec2(${Math.cos(angle).toFixed(6)}, ${Math.sin(angle).toFixed(6)})`
  // `direction` on the noise transitions: pixels further along it cross
  // later, so the crossing sweeps that way. No bias unless asked for.
  const sweep = noise?.direction === undefined ? '0.0' : `dot(v_uv - 0.5, ${direction}) * 0.8`

  const needsNoise = ['noise', 'liquid', 'ink'].includes(transition) || (transition === 'displace' && !hasMap)
  const noiseGLSL = needsNoise ? composeNoiseGLSL({ curl: false, displacement: transition === 'liquid' }) : ''

  // One entry per transition on spec §08's card. Everything around it
  // (uniforms, progress, output) is shared.
  const BLENDS: Record<DissolveTransition, string> = {
    crossfade: `
  outColor = mix(texture(u_from, v_uv), texture(u_to, v_uv), p);`,

    noise: `
  // Per-pixel CROSSING POINT drawn from simplex noise, NOT a plain lerp —
  // spec §08's own "why noise matters": a crossfade moves every pixel at
  // the same rate, which a real material never does. Each pixel crosses
  // once p passes its own threshold (n01), with a soft band around it.
  float n = simplexNoise(vec3(v_uv * ${scale}, ${seed}));
  float n01 = ${threshold} + 0.5 * n * ${intensity} + ${sweep};
  float localP = smoothstep(n01 - ${softness}, n01 + ${softness}, p);
  outColor = mix(texture(u_from, v_uv), texture(u_to, v_uv), localP);`,

    liquid: `
  // liquid: noise's per-pixel crossing PLUS displacement on the sampling
  // uv (gl/noise.ts's displacementOffset(), the sampler spec §07 shares
  // with distort's liquid/glass) — A reads as FLOWING into B.
  vec2 flow = displacementOffset(v_uv, p, ${(Number(intensity) * 0.05).toFixed(6)});
  vec2 fromUv = clamp(v_uv - flow * (1.0 - p), 0.0, 1.0);
  vec2 toUv = clamp(v_uv + flow * p, 0.0, 1.0);
  float n = simplexNoise(vec3(v_uv * ${scale}, p * 2.0 + ${seed}));
  float n01 = ${threshold} + 0.5 * n * ${intensity} + ${sweep};
  float localP = smoothstep(n01 - ${softness}, n01 + ${softness}, p);
  outColor = mix(texture(u_from, fromUv), texture(u_to, toUv), localP);`,

    dissolve: `
  // dissolve: the classic film dissolve — a per-PIXEL random threshold
  // (fine speckle), unlike 'noise''s smooth regions.
  float n = fract(sin(dot(floor(v_uv * u_resolution) + ${seed}, vec2(12.9898, 78.233))) * 43758.5453);
  float n01 = ${threshold} + (n - 0.5) * ${intensity} + ${sweep};
  float localP = smoothstep(n01 - ${softness} * 0.2, n01 + ${softness} * 0.2, p);
  outColor = mix(texture(u_from, v_uv), texture(u_to, v_uv), localP);`,

    displace: `
  // displace: both images are pushed by a displacement field — A away as
  // it leaves, B into place as it arrives — so the edge of the change
  // ripples. The field is the caller's \`map\` (its red/green around 0.5),
  // or procedural noise without one.
  vec2 field = ${hasMap ? 'texture(u_map, v_uv).rg - 0.5' : `vec2(simplexNoise(vec3(v_uv * ${scale}, ${seed})), simplexNoise(vec3(v_uv * ${scale} + 17.0, ${seed}))) * 0.5`};
  float push = 0.25 * ${intensity};
  vec4 a = texture(u_from, clamp(v_uv + field * p * push, 0.0, 1.0));
  vec4 b = texture(u_to, clamp(v_uv - field * (1.0 - p) * push, 0.0, 1.0));
  outColor = mix(a, b, smoothstep(0.2, 0.8, p));`,

    wipe: `
  // wipe: a soft edge sweeps across in \`noise.direction\` (default left to
  // right), B behind it.
  vec2 dir = ${direction};
  float along = dot(v_uv - 0.5, dir) / (abs(dir.x) + abs(dir.y)) + 0.5;
  float edge = ${softness} * 0.5;
  float t = mix(-edge, 1.0 + edge, p);
  outColor = mix(texture(u_from, v_uv), texture(u_to, v_uv), 1.0 - smoothstep(t - edge, t + edge, along));`,

    zoomBlur: `
  // zoomBlur: a radial blur toward the centre, strongest mid-transition,
  // while A turns into B inside it.
  float strength = sin(p * 3.14159265) * 0.3 * ${intensity};
  float toB = smoothstep(0.35, 0.65, p);
  vec2 c = v_uv - 0.5;
  vec4 sum = vec4(0.0);
  for (int i = 0; i < 12; i++) {
    vec2 q = 0.5 + c * (1.0 - strength * float(i) / 11.0);
    sum += mix(texture(u_from, q), texture(u_to, q), toB);
  }
  outColor = sum / 12.0;`,

    pixelBridge: `
  // pixelBridge: both images break into blocks that grow to the midpoint,
  // swap there, and resolve as B.
  float size = max(1.0, sin(p * 3.14159265) * 48.0 * ${intensity});
  vec2 cell = size / u_resolution;
  vec2 q = size > 1.0 ? (floor(v_uv / cell) + 0.5) * cell : v_uv;
  outColor = mix(texture(u_from, q), texture(u_to, q), smoothstep(0.45, 0.55, p));`,

    ink: `
  // ink: B spreads in like ink blots from the centre — a noisy, organic
  // front with a dark rim where the ink is wet.
  float n = simplexNoise(vec3(v_uv * ${scale} * 1.5, ${seed})) * 0.5 + 0.5;
  float reach = (1.0 - distance(v_uv, vec2(0.5)) * 1.2) * 0.6 + n * 0.6 * ${intensity};
  float t = mix(1.4, -0.4, p);
  float k = smoothstep(t - ${softness} * 0.3, t + ${softness} * 0.3, reach);
  float rim = 1.0 - abs(k * 2.0 - 1.0);
  vec4 c = mix(texture(u_from, v_uv), texture(u_to, v_uv), k);
  outColor = vec4(c.rgb * (1.0 - rim * 0.55), c.a);`,

    flip: `
  // flip: a card turning on its vertical axis — A narrows away to edge-on,
  // then B widens in. Darker edge-on, empty outside the card.
  float c = cos(p * 3.14159265);
  float w = max(abs(c), 0.0001);
  float x = (v_uv.x - 0.5) / w + 0.5;
  if (x < 0.0 || x > 1.0) {
    outColor = vec4(0.0);
  } else {
    vec4 face = c > 0.0 ? texture(u_from, vec2(x, v_uv.y)) : texture(u_to, vec2(x, v_uv.y));
    outColor = vec4(face.rgb * (0.55 + 0.45 * w), face.a);
  }`,

    glitch: `
  // glitch: bands of rows jump sideways and split their colour channels,
  // peaking mid-transition; each band switches to B at a slightly
  // different moment.
  float g = sin(p * 3.14159265) * ${intensity};
  float band = floor(v_uv.y * 24.0);
  float h = fract(sin((band + ${seed} * 13.0) * 78.233) * 43758.5453);
  float shift = (h - 0.5) * 0.15 * g * step(0.5, fract(h * 7.0 + p * 3.0));
  float pick = step(0.5, p + (h - 0.5) * 0.4 * g);
  vec2 q = vec2(v_uv.x + shift, v_uv.y);
  vec2 split = vec2(0.012 * g, 0.0);
  vec4 mid = mix(texture(u_from, q), texture(u_to, q), pick);
  outColor = vec4(
    mix(texture(u_from, q + split).r, texture(u_to, q + split).r, pick),
    mid.g,
    mix(texture(u_from, q - split).b, texture(u_to, q - split).b, pick),
    mid.a
  );`,

    mask: `
  // mask: B appears through the mask (a shape, text, another image or a
  // video — core's mask field, section 07), then fills in.
  float edge = 0.08;
  float t = mix(1.0 + edge, -edge, p);
  outColor = mix(texture(u_from, v_uv), texture(u_to, v_uv), smoothstep(t - edge, t + edge, sampleMask(v_uv)));`,
  }

  return `#version 300 es
precision mediump float;

uniform float u_progress;
uniform sampler2D u_from;
uniform sampler2D u_to;
uniform vec2 u_resolution;
${hasMap ? 'uniform sampler2D u_map;' : ''}
${transition === 'mask' ? MASK_SAMPLE_GLSL : ''}

in vec2 v_uv;
out vec4 outColor;

${noiseGLSL}

void main() {
  float p = clamp(u_progress, 0.0, 1.0);
  ${BLENDS[transition]}
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
  uResolution?: WebGLUniformLocation | null
  uMap?: WebGLUniformLocation | null
  /** For 'mask': what bindMaskUniforms() writes. */
  mask?: Parameters<typeof bindMaskUniforms>[1] | null
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
// A real bug found running many dissolve() instances on one real page: two
// instances compiling the same config share ONE cached program, so the
// first instance to tear down must not delete it out from under a still-live
// second instance holding the same reference.
const REFCOUNTS = new WeakMap<WebGL2RenderingContext, Map<string, number>>()

function cacheKey(options: DissolveShaderOptions): string {
  const { transition, noise, hasMap = false } = options
  return `${transition}:${noise?.scale ?? 3}:${noise?.intensity ?? 1}:${noise?.softness ?? 0.15}:${noise?.direction ?? ''}:${noise?.threshold ?? 0.5}:${noise?.seed ?? 0}:${hasMap}`
}

export function compileDissolveProgram(gl: WebGL2RenderingContext, options: DissolveShaderOptions): DissolveProgram | null {
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

  const result: DissolveProgram = {
    program,
    vao,
    uProgress: gl.getUniformLocation(program, 'u_progress'),
    uFrom: gl.getUniformLocation(program, 'u_from'),
    uTo: gl.getUniformLocation(program, 'u_to'),
    uResolution: gl.getUniformLocation(program, 'u_resolution'),
    uMap: gl.getUniformLocation(program, 'u_map'),
    mask:
      options.transition === 'mask'
        ? {
            uMaskKind: gl.getUniformLocation(program, 'u_maskKind'),
            uMaskTexture: gl.getUniformLocation(program, 'u_maskTexture'),
            uMaskUvTransform: gl.getUniformLocation(program, 'u_maskUvTransform'),
            uMaskCursorCenter: gl.getUniformLocation(program, 'u_maskCursorCenter'),
            uMaskCursorRadius: gl.getUniformLocation(program, 'u_maskCursorRadius'),
            uMaskCursorSoftness: gl.getUniformLocation(program, 'u_maskCursorSoftness'),
            uMaskCursorFalloff: gl.getUniformLocation(program, 'u_maskCursorFalloff'),
          }
        : null,
  }
  byConfig.set(key, result)
  refcounts.set(key, 1) // this compile call is itself the first live reference
  return result
}

export function destroyDissolveProgram(gl: WebGL2RenderingContext, dissolveProgram: DissolveProgram): void {
  const byConfig = PROGRAM_CACHE.get(gl)
  const refcounts = REFCOUNTS.get(gl)
  const key = byConfig ? [...byConfig.entries()].find(([, program]) => program === dissolveProgram)?.[0] : undefined

  if (key !== undefined && refcounts) {
    const remaining = (refcounts.get(key) ?? 1) - 1
    if (remaining > 0) {
      refcounts.set(key, remaining)
      return // other instances still hold this program — do not delete it
    }
    refcounts.delete(key)
    byConfig?.delete(key)
  }

  gl.deleteProgram(dissolveProgram.program)
  gl.deleteVertexArray(dissolveProgram.vao)
}

export type DissolveDrawState = {
  progress: number
  /** CSS px of the stage, for the per-pixel transitions. */
  resolutionWidth?: number
  resolutionHeight?: number
  /** 'displace''s map texture, when the caller gave one. */
  mapTexture?: WebGLTexture | null
  /** 'mask''s field (core's mask producers). An absent field reveals
   *  nothing, so the transition holds on `from` until the mask exists. */
  maskField?: MaskField | null
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
  gl.uniform2f(dissolveProgram.uResolution ?? null, state.resolutionWidth ?? 1, state.resolutionHeight ?? 1)
  if (state.mapTexture) {
    const mapUnit = pool.bind(state.mapTexture)
    if (mapUnit !== null) gl.uniform1i(dissolveProgram.uMap ?? null, mapUnit)
  }
  if (dissolveProgram.mask) {
    const field = state.maskField ?? null
    const maskUnit = field?.kind === 'texture' ? (pool.bind(field.texture) ?? fromUnit) : fromUnit
    bindMaskUniforms(gl, dissolveProgram.mask, field, maskUnit)
  }

  gl.enable(gl.BLEND)
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

  gl.bindVertexArray(null)
}
