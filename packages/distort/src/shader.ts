/**
 * @comice/distort/shader
 * ─────────────────────────────────────────────────────────────────────────────
 * T8's second half (see packages/dissolve/src/shader.ts's own header for
 * the full T2/T5 context). Spec §08's `distort` card: "Owns: field
 * distortion that follows an input. The cursor is a force in the field,
 * not a shape drawn at a point."
 *
 * SCOPE: three of the spec card's eight effects — `bulge`, `lens`,
 * `glass` — chosen because together they prove the general pattern
 * (radial push → magnify → refract) every remaining effect (`ripple`,
 * `smear`, `shapedLens`, `tear`, `liquid`) extends. `glass` specifically
 * exercises gl/noise.ts's `displacementOffset()` — the SAME sampler
 * packages/dissolve/src/shader.ts's `liquid` transition uses (spec §07's
 * own point: "dissolve's noise and liquid transitions and distort's
 * liquid and glass presets are the same math pointed at different
 * targets"). `ripple`/`smear`/`shapedLens`/`tear`/`liquid` are a
 * follow-up.
 *
 * NO LEGACY REFERENCE — `distort` (as `pointer` in legacy's own naming
 * history, per spec §08's "Was" column) has no working implementation in
 * `legacy/`. Designed from spec §08's own text, not ported.
 *
 * POINTER POSITION: reads `u_pointer` (normalized -1..1, the SAME
 * convention morph's own u_mouse uniform already established) and
 * `u_pointerActive` (0/1, whether the pointer is currently within
 * `radius` of the target at all — spec's own `radius` option: "Influence
 * radius, px."). A consumer drives both via .driver(pointer()) — see
 * index.ts for how packages/core/src/index.ts's NEW signal.pointer ->
 * instance.display.x/y routing (added specifically to unblock this
 * plugin, see ROADMAP.md's T8 entry) reaches this shader's uniforms.
 */

import { getResidencyPool } from 'comice/gl'
import { composeNoiseGLSL } from 'comice/gl'
import type { GLContext, Plane } from 'comice/gl'

export type DistortEffect = 'bulge' | 'lens' | 'ripple' | 'smear' | 'shapedLens' | 'tear' | 'liquid' | 'glass'

export type DistortShaderOptions = {
  effect: DistortEffect
  /** Edge falloff shape of the field, spec §08's own `falloff` option.
   *  Default 'smooth'. */
  falloff?: 'linear' | 'smooth' | 'exp'
}

const VERTEX_SHADER = `#version 300 es
in vec2 a_position;
in vec2 a_uv;
out vec2 v_uv;

void main() {
  v_uv = a_uv;
  gl_Position = vec4(a_position, 0.0, 1.0);
}`

function falloffGLSL(falloff: 'linear' | 'smooth' | 'exp'): string {
  // All three take a normalized distance-from-center d (0 at the
  // pointer, 1 at radius) and return a 1..0 field strength.
  if (falloff === 'linear') return '1.0 - clamp(d, 0.0, 1.0)'
  if (falloff === 'exp') return 'exp(-d * d * 4.0)'
  return '1.0 - smoothstep(0.0, 1.0, d)' // 'smooth', the default
}

/**
 * Builds the fragment shader for one DistortShaderOptions configuration.
 * Like dissolve (and unlike morph), samples the target's own single
 * media texture at plain UV — no aspect-normalized `st` space, since a
 * distortion field doesn't need one; it operates directly in the media's
 * own UV space, scaled by aspect only where the field's radius needs to
 * stay circular regardless of the element's aspect ratio.
 */
function buildFragmentShader(options: DistortShaderOptions): string {
  const { effect, falloff = 'smooth' } = options
  const fieldExpr = falloffGLSL(falloff)
  const needsNoise = effect === 'glass'
  const noiseGLSL = needsNoise ? composeNoiseGLSL({ curl: false, displacement: true }) : ''

  // Every effect reads the same field: distance from the pointer (d, in
  // units of the radius, aspect-corrected so it's round), the falloff, and
  // the pointer's activity. What differs is what the field does to the
  // pixels underneath. One entry per effect on spec §08's card.
  const FIELD = `
  vec2 toPointer = uv - (u_pointer * 0.5 + 0.5);
  float d = length(toPointer * vec2(aspect, 1.0)) / (u_radius);
  float field = (${fieldExpr}) * u_strength * u_pointerActive;`

  const EFFECTS: Record<DistortEffect, string> = {
    bulge: `
  // bulge: pushes samples radially outward from the pointer, strongest
  // at the center, fading to none at the field's edge — the classic
  // "poke a soft surface" distortion.
  //
  // toPointer is this pixel minus the pointer's position IN UV SPACE —
  // parenthesized. Unparenthesized, \`uv - u_pointer * 0.5 + 0.5\` ADDS 0.5
  // instead of subtracting it, which put the field's centre at
  // uv - (0.5, 0.5) relative to the real pointer: entirely off-image, so
  // no pixel was ever close enough to move. Same fix in lens and glass.
  vec2 toPointer = uv - (u_pointer * 0.5 + 0.5);
  float d = length(toPointer * vec2(aspect, 1.0)) / (u_radius);
  float field = (${fieldExpr}) * u_strength * u_pointerActive;
  vec2 dir = normalize(toPointer * vec2(aspect, 1.0) + 0.00001);
  // Ramp the push in from zero over the inner third of the radius. A unit
  // direction times full field strength is discontinuous AT the pointer
  // (the direction flips from one side to the other), which tore a pinched
  // black hole into the image exactly under the cursor.
  float ramp = smoothstep(0.0, 0.35, d);
  vec2 offset = -dir * field * ramp * 0.12;
  outColor = texture(u_media, clamp(uv + offset, 0.0, 1.0));`,
    lens: `
  // lens: samples pull INWARD toward the pointer (the opposite sign of
  // bulge's push), reading as local magnification rather than a poke.
  vec2 toPointer = uv - (u_pointer * 0.5 + 0.5);
  float d = length(toPointer * vec2(aspect, 1.0)) / (u_radius);
  float field = (${fieldExpr}) * u_strength * u_pointerActive;
  vec2 offset = toPointer * field * 0.5;
  outColor = texture(u_media, clamp(uv - offset, 0.0, 1.0));`,
    glass: `
  // glass: refracts through displacementOffset() (gl/noise.ts, T5 — the
  // SAME sampler dissolve's liquid transition uses) rather than
  // displacing samples directly, plus a chromatic-fringe split on the
  // red/blue channels (the same technique morph's shader already uses
  // for its own glass-lip refraction) so the lens genuinely reads as
  // bending light, not just offsetting pixels. Uses the procedural
  // displacementOffset(uv, time, strength) overload, not the
  // texture-map one — a glass lens has no displacement map to read, and
  // 'd' (distance from the pointer) stands in for 'time' here so the
  // refraction pattern is spatially stable under a static cursor rather
  // than a flat, unvarying offset (what a constant time input would give).
  vec2 toPointer = uv - (u_pointer * 0.5 + 0.5);
  float d = length(toPointer * vec2(aspect, 1.0)) / (u_radius);
  float field = (${fieldExpr}) * u_strength * u_pointerActive;
  vec2 refraction = displacementOffset(uv, d, field * (0.03 + u_refraction * 0.05));
  vec2 fringe = refraction * 0.35;
  vec4 mediaColor = texture(u_media, clamp(uv + refraction, 0.0, 1.0));
  outColor = vec4(
    texture(u_media, clamp(uv + refraction + fringe, 0.0, 1.0)).r,
    mediaColor.g,
    texture(u_media, clamp(uv + refraction - fringe, 0.0, 1.0)).b,
    mediaColor.a
  );`,
    ripple: `
  // ripple: rings travel outward from the pointer, like a drop in water —
  // samples move along the radial direction by a sine of distance minus
  // time, fading out with the field.
  ${FIELD}
  vec2 dir = normalize(toPointer * vec2(aspect, 1.0) + 0.00001) / vec2(aspect, 1.0);
  float wave = sin(d * 18.0 - u_time * 6.0);
  // Ramped in from the pointer, like bulge: a unit direction is
  // discontinuous there and pinched the image into a blob under the cursor.
  float ramp = smoothstep(0.0, 0.35, d);
  outColor = texture(u_media, clamp(uv + dir * wave * field * ramp * 0.035, 0.0, 1.0));`,
    smear: `
  // smear: pixels drag along the pointer's motion — each sample reaches
  // back against the velocity, so a fast swipe streaks and a still pointer
  // leaves the image untouched.
  ${FIELD}
  outColor = texture(u_media, clamp(uv - u_velocity * field * 8.0, 0.0, 1.0));`,
    shapedLens: `
  // shapedLens: lens's inward pull, but the field's edge is a squircle
  // (|x|^4 + |y|^4) rather than a circle — a rounded-square magnifier.
  vec2 toPointer = uv - (u_pointer * 0.5 + 0.5);
  vec2 q = abs(toPointer * vec2(aspect, 1.0));
  float d = pow(pow(q.x, 4.0) + pow(q.y, 4.0), 0.25) / (u_radius);
  float field = (${fieldExpr}) * u_strength * u_pointerActive;
  outColor = texture(u_media, clamp(uv - toPointer * field * 0.5, 0.0, 1.0));`,
    tear: `
  // tear: the image rips apart along a ragged horizontal line through the
  // pointer. Rows above and below pull away from it; inside the gap there
  // is nothing (the page shows through). The rip is widest under the
  // pointer and closes toward the edge of the radius.
  vec2 tp = (uv - (u_pointer * 0.5 + 0.5)) * vec2(aspect, 1.0);
  float d = abs(tp.x) / (u_radius);
  float field = (${fieldExpr}) * u_strength * u_pointerActive;
  float ragged = (fract(sin(floor(uv.x * u_resolution.x / 3.0) * 12.9898) * 43758.5453) - 0.5) * 0.008 * field;
  float y = tp.y + ragged;
  float gap = field * 0.04;
  if (abs(y) < gap) {
    outColor = vec4(0.0);
  } else {
    outColor = texture(u_media, clamp(uv - vec2(0.0, sign(y) * gap), 0.0, 1.0));
  }`,
    liquid: `
  // liquid: "pushes them, carrying momentum so the surface settles after
  // the cursor has gone" (spec). The push lives in a displacement field
  // the step pass (LIQUID_STEP) keeps in core's feedback buffer from frame
  // to frame — it decays rather than vanishing, so the surface keeps
  // moving after the pointer stops. Encoded around 0.5 (8-bit texture).
  vec2 push = texture(u_field, uv).rg - 0.5;
  outColor = texture(u_media, clamp(uv - push * 0.25, 0.0, 1.0));`,
  }
  const distortGLSL = EFFECTS[effect]

  return `#version 300 es
precision mediump float;

uniform vec2 u_resolution;
uniform vec2 u_pointer;       // normalized -1..1, same convention as morph's u_mouse
uniform float u_pointerActive; // 0..1
uniform float u_radius;        // normalized (0..1-ish) field radius
uniform float u_strength;
uniform float u_refraction;    // only meaningful for 'glass'
uniform sampler2D u_media;
uniform float u_time;          // seconds, for 'ripple'
uniform vec2 u_velocity;       // pointer motion, uv per frame, for 'smear'
uniform sampler2D u_field;     // displacement field, for 'liquid'

in vec2 v_uv;
out vec4 outColor;

${noiseGLSL}

void main() {
  vec2 uv = v_uv;
  float aspect = u_resolution.x / u_resolution.y;
  ${distortGLSL}
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

export type DistortProgram = {
  program: WebGLProgram
  vao: WebGLVertexArrayObject
  uResolution: WebGLUniformLocation | null
  uPointer: WebGLUniformLocation | null
  uPointerActive: WebGLUniformLocation | null
  uRadius: WebGLUniformLocation | null
  uStrength: WebGLUniformLocation | null
  uRefraction: WebGLUniformLocation | null
  uMedia: WebGLUniformLocation | null
  uTime?: WebGLUniformLocation | null
  uVelocity?: WebGLUniformLocation | null
  uField?: WebGLUniformLocation | null
}

const PROGRAM_CACHE = new WeakMap<WebGL2RenderingContext, Map<string, DistortProgram | null>>()
// A real bug found running many distort() instances on one real page
// (including the hero's own distort()+color() stack, plus other distort()
// instances elsewhere): two instances compiling the same config share ONE
// cached program, so the first instance to tear down must not delete it
// out from under a still-live second instance holding the same reference.
const REFCOUNTS = new WeakMap<WebGL2RenderingContext, Map<string, number>>()

function cacheKey(options: DistortShaderOptions): string {
  return `${options.effect}:${options.falloff ?? 'smooth'}`
}

export function compileDistortProgram(gl: WebGL2RenderingContext, options: DistortShaderOptions): DistortProgram | null {
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

  const result: DistortProgram = {
    program,
    vao,
    uResolution: gl.getUniformLocation(program, 'u_resolution'),
    uPointer: gl.getUniformLocation(program, 'u_pointer'),
    uPointerActive: gl.getUniformLocation(program, 'u_pointerActive'),
    uRadius: gl.getUniformLocation(program, 'u_radius'),
    uStrength: gl.getUniformLocation(program, 'u_strength'),
    uRefraction: gl.getUniformLocation(program, 'u_refraction'),
    uMedia: gl.getUniformLocation(program, 'u_media'),
    uTime: gl.getUniformLocation(program, 'u_time'),
    uVelocity: gl.getUniformLocation(program, 'u_velocity'),
    uField: gl.getUniformLocation(program, 'u_field'),
  }
  byConfig.set(key, result)
  refcounts.set(key, 1) // this compile call is itself the first live reference
  return result
}

export function destroyDistortProgram(gl: WebGL2RenderingContext, distortProgram: DistortProgram): void {
  const byConfig = PROGRAM_CACHE.get(gl)
  const refcounts = REFCOUNTS.get(gl)
  const key = byConfig ? [...byConfig.entries()].find(([, program]) => program === distortProgram)?.[0] : undefined

  if (key !== undefined && refcounts) {
    const remaining = (refcounts.get(key) ?? 1) - 1
    if (remaining > 0) {
      refcounts.set(key, remaining)
      return // other instances still hold this program — do not delete it
    }
    refcounts.delete(key)
    byConfig?.delete(key)
  }

  gl.deleteProgram(distortProgram.program)
  gl.deleteVertexArray(distortProgram.vao)
}

export type DistortDrawState = {
  pointerX: number
  pointerY: number
  pointerActive: boolean
  radius: number
  strength: number
  refraction: number
  resolutionWidth: number
  resolutionHeight: number
  /** Seconds, for 'ripple'. */
  time?: number
  /** Pointer motion in uv per frame (y up), for 'smear'. */
  velocityX?: number
  velocityY?: number
  /** The displacement field texture, for 'liquid' (see liquid.ts). */
  fieldTexture?: WebGLTexture | null
}

/**
 * Draws one distort pass. Assumes the caller has already called the
 * residency pool's beginPass() for this frame, matching morph/dissolve's
 * own convention — this function does not call beginPass() itself.
 *
 * Returns without drawing, never throwing, if `plane.texture` is null or
 * the residency pool's unit budget is exhausted this pass.
 */
export function drawDistort(context: GLContext, distortProgram: DistortProgram, plane: Plane, state: DistortDrawState): void {
  if (!plane.texture) return

  const pool = getResidencyPool(context)
  const unit = pool.bind(plane.texture)
  if (unit === null) return

  const { gl } = context
  gl.useProgram(distortProgram.program)
  gl.bindVertexArray(distortProgram.vao)

  gl.uniform2f(distortProgram.uResolution, state.resolutionWidth, state.resolutionHeight)
  gl.uniform2f(distortProgram.uPointer, state.pointerX, state.pointerY)
  gl.uniform1f(distortProgram.uPointerActive, state.pointerActive ? 1 : 0)
  gl.uniform1f(distortProgram.uRadius, state.radius)
  gl.uniform1f(distortProgram.uStrength, state.strength)
  gl.uniform1f(distortProgram.uRefraction, state.refraction)
  gl.uniform1i(distortProgram.uMedia, unit)
  gl.uniform1f(distortProgram.uTime ?? null, state.time ?? 0)
  gl.uniform2f(distortProgram.uVelocity ?? null, state.velocityX ?? 0, state.velocityY ?? 0)
  if (state.fieldTexture) {
    // Liquid needs two units (media + field); WebGL2 guarantees 16, so a
    // null here only happens against a deliberately tiny pool in tests.
    const fieldUnit = pool.bind(state.fieldTexture)
    if (fieldUnit !== null) gl.uniform1i(distortProgram.uField ?? null, fieldUnit)
  }

  gl.enable(gl.BLEND)
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

  gl.bindVertexArray(null)
}
