/**
 * @comice/mosaic/shader
 * ─────────────────────────────────────────────────────────────────────────────
 * T10 (ROADMAP.md §4): spec §08's `mosaic` card — "Owns: media rebuilt from
 * cells, still reading as a photograph. Dot, print and pattern degradation,
 * not text." Six fills on the card: `dither`, `halftone`, `riso`,
 * `pixelate`, `crosshatch`, `images`. ALL SIX SHIP THIS PASS.
 *
 * "STILL READING AS A PHOTOGRAPH" IS THE DESIGN CONSTRAINT — every fill
 * here quantizes/re-buckets the SAME sampled luminance/color per cell
 * rather than replacing the image with abstract noise, which is what
 * keeps `pixelate` (the simplest fill) and `dither` (the most complex)
 * both reading as "the same photo, degraded," not two unrelated effects
 * that happen to share a file.
 *
 * ERROR DIFFUSION EXCLUDED, PER SPEC'S OWN EXCLUDES: "Error diffusion
 * dithering is sequential and CPU bound, offered for stills, discouraged
 * for video." A real Floyd-Steinberg-style error-diffusion dither cannot
 * run as an embarrassingly-parallel GPU fragment shader at all — each
 * pixel's quantization error must propagate to pixels not yet processed,
 * which requires either a sequential CPU pass or a full compute-shader
 * scan (WebGL2 has neither). `dither` here is therefore an ORDERED
 * (Bayer-matrix) dither, the real-time GPU-native alternative every
 * browser-shader dithering implementation actually uses — spec's own
 * exclude is what rules OUT error diffusion, not what this shader does.
 *
 * `images` (the tile-pool fill) is this file's own T2 exercise — up to a
 * caller-supplied pool of `sources` media textures, one bound per
 * occupied residency unit, each screen cell sampling whichever pool tile
 * best matches that cell's own average luminance (the same "many photos
 * assemble into one portrait" mechanic spec's own card example
 * describes). Genuinely bounded by the residency pool's own unit budget —
 * a `sources` array larger than the pool can hold degrades to using only
 * the tiles that fit, never throws.
 */

import { getResidencyPool } from 'comice/gl'
import type { GLContext, Plane } from 'comice/gl'

export type MosaicFill = 'dither' | 'halftone' | 'riso' | 'pixelate' | 'crosshatch' | 'images'

export type MosaicShaderOptions = {
  fill: MosaicFill
  /** Cell size in px, the common "how big is one mosaic unit" knob every
   *  fill shares. Default 12. */
  cell?: number
  /** Number of palette colors `images`'s cell-matching and `dither`'s
   *  quantization both bucket into — a plain count (spec's own
   *  `palette: string[] | number` — the literal color LIST is index.ts's
   *  job to turn into a uniform array; this shader only needs the count
   *  to build its GLSL loop bound). Default 2. */
  paletteCount?: number
  /** True when the caller gave an explicit colour LIST (spec's "brand
   *  colours"), not just a count: the shader then reads `u_palette`
   *  (sRGB, sorted darkest to lightest) instead of greys / the media's own
   *  colours. Previously the list was accepted and silently ignored — only
   *  its length was used. Default false. */
  paletteColors?: boolean
  /** Number of tile sources available for `fill: 'images'` — bounds the
   *  shader's own sampler array declaration. Ignored for every other
   *  fill. Default 0. */
  sourceCount?: number
}

const VERTEX_SHADER = `#version 300 es
in vec2 a_position;
in vec2 a_uv;
out vec2 v_uv;

void main() {
  v_uv = a_uv;
  gl_Position = vec4(a_position, 0.0, 1.0);
}`

// A classic 4x4 Bayer ordered-dither threshold matrix — the standard
// real-time GPU dither pattern, values 0..15 normalized to 0..1. See the
// file header for why this replaces error-diffusion here.
const BAYER_GLSL = `
const float bayer4x4[16] = float[16](
   0.0,  8.0,  2.0, 10.0,
  12.0,  4.0, 14.0,  6.0,
   3.0, 11.0,  1.0,  9.0,
  15.0,  7.0, 13.0,  5.0
);
float bayerThreshold(vec2 cell) {
  int x = int(mod(cell.x, 4.0));
  int y = int(mod(cell.y, 4.0));
  return bayer4x4[y * 4 + x] / 16.0;
}`

// Brand-colour helpers (spec §10: palette fills interpolate in OKLCH by
// default). Palette colours arrive as sRGB; blends and distances happen in
// OKLab, through linear light, so a dot's edge between two brand colours
// never dips through grey.
const PALETTE_GLSL = `
vec3 srgbToLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 linearToSrgb(vec3 c) { c = max(c, 0.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
vec3 toOklab(vec3 srgb) {
  vec3 c = srgbToLinear(srgb);
  float l = 0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b;
  float m = 0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b;
  float s = 0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b;
  vec3 lms = pow(max(vec3(l, m, s), 0.0), vec3(1.0 / 3.0));
  return vec3(
    0.2104542553 * lms.x + 0.7936177850 * lms.y - 0.0040720468 * lms.z,
    1.9779984951 * lms.x - 2.4285922050 * lms.y + 0.4505937099 * lms.z,
    0.0259040371 * lms.x + 0.7827717662 * lms.y - 0.8086757660 * lms.z
  );
}
vec3 fromOklab(vec3 c) {
  float l_ = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
  float m_ = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
  float s_ = c.x - 0.0894841775 * c.y - 1.2914855480 * c.z;
  vec3 lms = vec3(l_ * l_ * l_, m_ * m_ * m_, s_ * s_ * s_);
  return linearToSrgb(vec3(
    4.0767416621 * lms.x - 3.3077115913 * lms.y + 0.2309699292 * lms.z,
    -1.2684380046 * lms.x + 2.6097574011 * lms.y - 0.3413193965 * lms.z,
    -0.0041960863 * lms.x - 0.7034186147 * lms.y + 1.7076147010 * lms.z
  ));
}
vec3 paletteMix(vec3 a, vec3 b, float t) { return fromOklab(mix(toOklab(a), toOklab(b), t)); }`

function buildDitherGLSL(paletteCount: number, paletteColors: boolean): string {
  // With brand colours each quantization level IS one of them, darkest to
  // lightest; without, the levels are greys, as before.
  const out = paletteColors
    ? `int level = int(clamp(floor(luma * (levels - 1.0) + threshold), 0.0, levels - 1.0));
    color.rgb = u_palette[level];`
    : `float quantized = floor(luma * (levels - 1.0) + threshold) / (levels - 1.0);
    color.rgb = vec3(clamp(quantized, 0.0, 1.0));`
  // One brightness per CELL, read at its centre — the threshold is per
  // cell, so reading brightness per pixel split cells wherever it crossed
  // the threshold mid-cell: broken specks and jagged fragments (seen in
  // Chromium, with or without a palette).
  return `
  {
    vec2 cell = floor(gl_FragCoord.xy / u_cell);
    float threshold = bayerThreshold(cell);
    vec2 cellUv = (cell * u_cell + u_cell * 0.5) / u_resolution;
    vec3 cellColor = texture(u_media, clamp(cellUv, 0.0, 1.0)).rgb;
    float luma = dot(cellColor, vec3(0.2126, 0.7152, 0.0722));
    float levels = max(2.0, ${paletteCount.toFixed(1)});
    ${out}
  }`
}

function buildHalftoneGLSL(paletteCount: number, paletteColors: boolean): string {
  // Classic CMYK-style halftone: each cell draws a dot whose radius
  // scales with that cell's own luminance (darker = bigger dot), sampled
  // via a per-cell radial distance field rather than a texture lookup —
  // the same "keep it analytic where the effect is cheap to describe
  // that way" discipline morph's sdf.ts and thread.ts both hold to.
  return `
  {
    vec2 cellSize = vec2(u_cell);
    vec2 cellCoord = mod(gl_FragCoord.xy, cellSize) - cellSize * 0.5;
    float luma = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));
    float radius = (1.0 - luma) * (u_cell * 0.5);
    float dist = length(cellCoord);
    float dot = 1.0 - smoothstep(radius - 1.0, radius + 1.0, dist);
    ${paletteColors ? `// Two-colour print: darkest brand colour is the ink, lightest the paper.
    color.rgb = paletteMix(u_palette[${paletteCount - 1}], u_palette[0], dot);` : 'color.rgb = vec3(1.0 - dot);'}
  }`
}

function buildRisoGLSL(): string {
  // Riso: a halftone-style dot pattern PER CHANNEL, each channel's dot
  // grid offset/angled differently (mimicking real risograph misregistration
  // between separate ink drums), then screened back together — this is
  // what makes riso read as a print process rather than a plain halftone.
  return `
  {
    vec2 cellSize = vec2(u_cell);
    float dotR = risoDot(gl_FragCoord.xy, cellSize, color.r, 0.0);
    float dotG = risoDot(gl_FragCoord.xy, cellSize, color.g, 2.0);
    float dotB = risoDot(gl_FragCoord.xy, cellSize, color.b, 4.0);
    color.rgb = vec3(dotR, dotG, dotB);
  }`
}

const RISO_HELPER_GLSL = `
float risoDot(vec2 fragCoord, vec2 cellSize, float channelValue, float angleOffsetCells) {
  vec2 offsetCoord = fragCoord + vec2(angleOffsetCells * cellSize.x * 0.15, 0.0);
  vec2 cellCoord = mod(offsetCoord, cellSize) - cellSize * 0.5;
  float radius = (1.0 - channelValue) * (cellSize.x * 0.5);
  float dist = length(cellCoord);
  return 1.0 - smoothstep(radius - 1.0, radius + 1.0, dist);
}`

function buildPixelateGLSL(paletteCount: number, paletteColors: boolean): string {
  // With brand colours each cell snaps to the NEAREST one, measured in
  // OKLab (perceptual distance), not RGB.
  const snap = paletteColors
    ? `
    vec3 lab = toOklab(color.rgb);
    vec3 best = u_palette[0];
    float bestDist = 1e9;
    for (int i = 0; i < ${paletteCount}; i++) {
      float d = distance(lab, toOklab(u_palette[i]));
      if (d < bestDist) { bestDist = d; best = u_palette[i]; }
    }
    color.rgb = best;`
    : ''
  return `
  {
    vec2 cellUv = (floor(gl_FragCoord.xy / u_cell) * u_cell + u_cell * 0.5) / u_resolution;
    color = texture(u_media, clamp(cellUv, 0.0, 1.0));${snap}
  }`
}

function buildCrosshatchGLSL(paletteCount: number, paletteColors: boolean): string {
  // Two diagonal line families, each family's density gated by luminance
  // — darker regions get both families (dense crosshatch), lighter
  // regions get none, matching real pen crosshatch shading.
  return `
  {
    float luma = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));
    vec2 p = gl_FragCoord.xy / u_cell;
    float linesA = mod(p.x + p.y, 1.0);
    float linesB = mod(p.x - p.y, 1.0);
    float hatchA = step(linesA, 1.0 - luma);
    float hatchB = step(linesB, 1.0 - luma * 1.6);
    float ink = max(hatchA, hatchB);
    ${paletteColors ? `// Pen on paper in brand colours: darkest is the ink, lightest the paper.
    color.rgb = paletteMix(u_palette[${paletteCount - 1}], u_palette[0], ink);` : 'color.rgb = mix(color.rgb, vec3(1.0) - ink * vec3(0.9), 0.85);'}
  }`
}

/** Builds the fragment shader for one MosaicShaderOptions configuration. */
export function buildFragmentShader(options: MosaicShaderOptions): string {
  const { fill, cell = 12, paletteCount = 2, sourceCount = 0 } = options
  // riso's look IS its three RGB ink drums, and images draws tiles: an
  // explicit palette doesn't apply to either.
  const paletteColors = !!options.paletteColors && fill !== 'riso' && fill !== 'images'
  const paletteUniform = paletteColors ? `uniform vec3 u_palette[${paletteCount}];` : ''

  let extraSamplers = ''
  let bodyGLSL: string
  let helperGLSL = ''

  switch (fill) {
    case 'dither':
      helperGLSL = BAYER_GLSL
      bodyGLSL = buildDitherGLSL(paletteCount, paletteColors)
      break
    case 'halftone':
      bodyGLSL = buildHalftoneGLSL(paletteCount, paletteColors)
      break
    case 'riso':
      helperGLSL = RISO_HELPER_GLSL
      bodyGLSL = buildRisoGLSL()
      break
    case 'pixelate':
      bodyGLSL = buildPixelateGLSL(paletteCount, paletteColors)
      break
    case 'crosshatch':
      bodyGLSL = buildCrosshatchGLSL(paletteCount, paletteColors)
      break
    case 'images': {
      const count = Math.max(1, sourceCount)
      extraSamplers = `uniform sampler2D u_sources[${count}];`
      const branches = Array.from({ length: count }, (_, i) => (i === 0 ? `if (bucket == 0) { color = texture(u_sources[0], cellUv); }` : `else if (bucket == ${i}) { color = texture(u_sources[${i}], cellUv); }`)).join('\n    ')
      bodyGLSL = `
  {
    vec2 cellUv = (floor(gl_FragCoord.xy / u_cell) * u_cell + u_cell * 0.5) / u_resolution;
    vec4 mediaColor = texture(u_media, clamp(cellUv, 0.0, 1.0));
    float luma = dot(mediaColor.rgb, vec3(0.2126, 0.7152, 0.0722));
    int bucket = int(clamp(luma * float(${count}), 0.0, float(${count - 1})));
    ${branches}
    else { color = mediaColor; }
  }`
      break
    }
  }

  return `#version 300 es
precision mediump float;

uniform sampler2D u_media;
${extraSamplers}
${paletteUniform}
uniform vec2 u_resolution;
uniform float u_cell;

in vec2 v_uv;
out vec4 outColor;

${helperGLSL}
${paletteColors ? PALETTE_GLSL : ''}

void main() {
  vec4 color = texture(u_media, v_uv);
  ${bodyGLSL}
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

export type MosaicProgram = {
  program: WebGLProgram
  vao: WebGLVertexArrayObject
  uMedia: WebGLUniformLocation | null
  uResolution: WebGLUniformLocation | null
  uCell: WebGLUniformLocation | null
  uSources: WebGLUniformLocation | null
  sourceCount: number
  /** Present only when the program was built for an explicit colour list. */
  uPalette: WebGLUniformLocation | null
}

const PROGRAM_CACHE = new WeakMap<WebGL2RenderingContext, Map<string, MosaicProgram | null>>()
// A real bug found running many mosaic() instances on one real page (hover-
// swapping fills on a grid of cards): two instances sharing the same
// (gl, config) key correctly share ONE compiled program via PROGRAM_CACHE
// above, but destroyMosaicProgram() used to delete that shared program
// unconditionally the moment ANY ONE instance tore down — breaking every
// other still-alive instance using it (a real, reproduced WebGL error:
// "useProgram: attempt to use a deleted object"). REFCOUNTS tracks how
// many live instances currently hold a reference to each cached entry;
// the actual GL delete + cache eviction only happens once the count drops
// to 0, so a shared program stays alive exactly as long as anyone needs
// it, and a genuinely-unused config still gets cleaned up rather than
// leaking forever.
const REFCOUNTS = new WeakMap<WebGL2RenderingContext, Map<string, number>>()

function cacheKey(options: MosaicShaderOptions): string {
  const { fill, cell = 12, paletteCount = 2, sourceCount = 0, paletteColors = false } = options
  return `${fill}:${cell}:${paletteCount}:${sourceCount}:${paletteColors}`
}

export function compileMosaicProgram(gl: WebGL2RenderingContext, options: MosaicShaderOptions): MosaicProgram | null {
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
    // A null cache entry (a previously-failed compile) is cached too —
    // never worth ref-counting, since there's no live GL object to share
    // or eventually delete for that key.
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

  const result: MosaicProgram = {
    program,
    vao,
    uMedia: gl.getUniformLocation(program, 'u_media'),
    uResolution: gl.getUniformLocation(program, 'u_resolution'),
    uCell: gl.getUniformLocation(program, 'u_cell'),
    uSources: options.fill === 'images' ? gl.getUniformLocation(program, 'u_sources') : null,
    sourceCount: options.fill === 'images' ? Math.max(1, options.sourceCount ?? 0) : 0,
    uPalette: options.paletteColors && options.fill !== 'riso' && options.fill !== 'images' ? gl.getUniformLocation(program, 'u_palette') : null,
  }
  byConfig.set(key, result)
  refcounts.set(key, 1) // this compile call is itself the first live reference
  return result
}

/**
 * Releases one reference to `mosaicProgram`. The underlying GL program/VAO
 * is only actually deleted (and its cache entry evicted, so a later
 * compileMosaicProgram() call with the same config genuinely recompiles
 * rather than returning a deleted object) once every instance sharing it
 * has released its own reference — see REFCOUNTS's own comment above for
 * the real bug this fixes. Safe to call more times than compile was
 * called for a given config (a defensive floor at 0, never negative) —
 * teardown() ordering across plugin instances isn't guaranteed to be
 * perfectly 1:1 in every caller, and this must never double-delete or
 * throw on the "already gone" case regardless.
 */
export function destroyMosaicProgram(gl: WebGL2RenderingContext, mosaicProgram: MosaicProgram): void {
  const byConfig = PROGRAM_CACHE.get(gl)
  const refcounts = REFCOUNTS.get(gl)
  const key = byConfig ? [...byConfig.entries()].find(([, program]) => program === mosaicProgram)?.[0] : undefined

  if (key !== undefined && refcounts) {
    const remaining = (refcounts.get(key) ?? 1) - 1
    if (remaining > 0) {
      refcounts.set(key, remaining)
      return // other instances still hold this program — do not delete it
    }
    refcounts.delete(key)
    byConfig?.delete(key)
  }

  gl.deleteProgram(mosaicProgram.program)
  gl.deleteVertexArray(mosaicProgram.vao)
}

export type MosaicDrawState = {
  resolutionWidth: number
  resolutionHeight: number
  cell: number
  /** Brand colours as flat sRGB triples, darkest first. */
  palette?: Float32Array
}

/**
 * Draws one mosaic pass. Binds the media texture, and for `fill:
 * 'images'`, up to `mosaicProgram.sourceCount` tile textures, all through
 * the shared ResidencyPool. Assumes the caller already called
 * beginPass() this frame (see every other drawX() in this repo).
 *
 * Returns without drawing, never throwing, if the media plane has no
 * texture yet, or the residency pool's unit budget is exhausted before
 * the media texture itself gets a unit. For `images`, a `sources` array
 * that doesn't fully fit the remaining budget simply binds as many tiles
 * as fit — cells whose bucket exceeds the bound count fall back to
 * `u_sources[0]`'s own sampler slot reading whatever's bound there
 * (degrade, never throw).
 */
export function drawMosaic(context: GLContext, mosaicProgram: MosaicProgram, mediaPlane: Plane, sourcePlanes: readonly Plane[], state: MosaicDrawState): void {
  if (!mediaPlane.texture) return

  const pool = getResidencyPool(context)
  const mediaUnit = pool.bind(mediaPlane.texture)
  if (mediaUnit === null) return

  const sourceUnits: number[] = []
  for (let i = 0; i < mosaicProgram.sourceCount; i++) {
    const plane = sourcePlanes[i]
    const texture = plane?.texture ?? null
    if (!texture) {
      sourceUnits.push(mediaUnit) // no tile uploaded yet -> reads the media unit, a harmless placeholder
      continue
    }
    const unit = pool.bind(texture)
    sourceUnits.push(unit === null ? mediaUnit : unit)
  }

  const { gl } = context
  gl.useProgram(mosaicProgram.program)
  gl.bindVertexArray(mosaicProgram.vao)

  gl.uniform1i(mosaicProgram.uMedia, mediaUnit)
  gl.uniform2f(mosaicProgram.uResolution, state.resolutionWidth, state.resolutionHeight)
  gl.uniform1f(mosaicProgram.uCell, Math.max(1, state.cell))
  if (mosaicProgram.uSources && sourceUnits.length > 0) {
    gl.uniform1iv(mosaicProgram.uSources, sourceUnits)
  }
  if (mosaicProgram.uPalette && state.palette) {
    gl.uniform3fv(mosaicProgram.uPalette, state.palette)
  }

  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

  gl.bindVertexArray(null)
}
