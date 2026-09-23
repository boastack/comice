/**
 * comice/core/gl/noise
 * ─────────────────────────────────────────────────────────────────────────────
 * T5 (ROADMAP.md §4), the last of the four §07 primitives. Spec §07: "One
 * GLSL library, simplex and curl noise plus a common displacement sampler.
 * dissolve's noise and liquid transitions and distort's liquid and glass
 * presets are the same math pointed at different targets. Two copies would
 * drift, and the second one would be written by someone reading the first."
 *
 * Unlike context.ts/plane.ts/residency.ts/mask.ts/feedback.ts, this file
 * allocates nothing on the GPU and drives no draw calls of its own — there
 * is no per-instance state, no render target, nothing to leak, because
 * there is nothing to allocate. What §07 asks this file to own is
 * narrower and purely textual: ONE copy of this math, in GLSL source,
 * that every future shader-writing consumer (`dissolve`'s noise/liquid
 * transitions, `distort`'s liquid/glass presets, T7's `morph`) imports and
 * splices into its own fragment shader rather than each hand-copying or
 * re-deriving simplex noise from scratch.
 *
 * This is why the file's only exports are GLSL source strings (plus one
 * small compose helper) rather than anything that touches a
 * WebGL2RenderingContext directly — there is no createXxx()/destroy()
 * pair here because there is no GPU resource for one to manage. The
 * "shared library" IS the string.
 *
 * Sources: the simplex noise implementation is Ian McEwan / Ashima Arts'
 * widely-used, public-domain GLSL port of Stefan Gustavson's simplex
 * noise (the same implementation nearly every WebGL noise library in the
 * wild traces back to — reproducing it here rather than inventing a new
 * one is deliberate: it is well-understood, well-tested math, and
 * "two copies would drift" applies just as much to reinventing simplex
 * noise as to copy-pasting an existing implementation across plugins).
 */

/**
 * 3D simplex noise, returning a single float in roughly [-1, 1]. Declares
 * `float simplexNoise(vec3 v)`. The classic Ashima Arts GLSL port —
 * permutation-table-free (no texture lookup, pure ALU), which matters on
 * mobile where a texture-based noise lookup would compete with plane.ts's
 * own texture-unit budget (residency.ts, T2) for no benefit.
 */
export const SIMPLEX_NOISE_GLSL = `
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float simplexNoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);

  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);

  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);

  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;

  i = mod289(i);
  vec4 p = permute(permute(permute(
            i.z + vec4(0.0, i1.z, i2.z, 1.0))
          + i.y + vec4(0.0, i1.y, i2.y, 1.0))
          + i.x + vec4(0.0, i1.x, i2.x, 1.0));

  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;

  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);

  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);

  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);

  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);

  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));

  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;

  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);

  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x;
  p1 *= norm.y;
  p2 *= norm.z;
  p3 *= norm.w;

  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
`

/**
 * Curl noise: a divergence-free vector field derived from simplexNoise's
 * gradient, the standard "fluid-like" flow field every liquid/flow
 * transition in the catalogue wants (dissolve's liquid transition,
 * distort's liquid preset). Declares `vec3 curlNoise(vec3 p)`. Depends on
 * simplexNoise() — a consumer that splices in CURL_NOISE_GLSL must also
 * splice in SIMPLEX_NOISE_GLSL first (see composeNoiseGLSL() below, which
 * does this concatenation correctly so a consumer doesn't have to
 * remember the ordering itself).
 */
export const CURL_NOISE_GLSL = `
vec3 curlNoise(vec3 p) {
  const float e = 0.1;
  vec3 dx = vec3(e, 0.0, 0.0);
  vec3 dy = vec3(0.0, e, 0.0);
  vec3 dz = vec3(0.0, 0.0, e);

  float x0 = simplexNoise(p - dx);
  float x1 = simplexNoise(p + dx);
  float y0 = simplexNoise(p - dy);
  float y1 = simplexNoise(p + dy);
  float z0 = simplexNoise(p - dz);
  float z1 = simplexNoise(p + dz);

  float dydz = (y1 - y0) - (z1 - z0);
  float dzdx = (z1 - z0) - (x1 - x0);
  float dxdy = (x1 - x0) - (y1 - y0);

  const float divisor = 1.0 / (2.0 * e);
  return normalize(vec3(dydz, dzdx, dxdy) * divisor);
}
`

/**
 * A common displacement sampler — declares `vec2 displacementOffset(vec2
 * uv, sampler2D map, float strength)`, reading a displacement map's red/
 * green channels as an x/y offset (the same convention dissolve's
 * `displace` transition's `map` option and distort's `liquid`/`glass`
 * presets both need, per §07's "dissolve's noise and liquid transitions
 * and distort's liquid and glass presets are the same math pointed at
 * different targets") and a second overload driven by simplexNoise/
 * curlNoise directly, for callers with no displacement texture at all
 * (a pure procedural liquid effect, not one keyed off an uploaded map).
 * Both overloads return an offset in UV space (typically tiny — 0.0..0.1
 * range — a caller multiplies by its own `strength`-equivalent before
 * adding to a sample UV).
 */
export const DISPLACEMENT_SAMPLER_GLSL = `
vec2 displacementOffset(vec2 uv, sampler2D map, float strength) {
  vec2 raw = texture(map, uv).rg * 2.0 - 1.0; // [0,1] texture -> [-1,1] offset
  return raw * strength;
}

vec2 displacementOffset(vec2 uv, float time, float strength) {
  vec3 sample3 = vec3(uv * 4.0, time);
  float nx = simplexNoise(sample3);
  float ny = simplexNoise(sample3 + vec3(37.0, 17.0, 0.0)); // offset seed so x/y don't correlate
  return vec2(nx, ny) * strength;
}
`

/**
 * Concatenates the noise library's chunks in dependency order (simplex
 * before curl, since curl calls simplexNoise) plus the displacement
 * sampler, and returns one GLSL source block a consumer splices into its
 * fragment shader once. Equivalent to hand-concatenating
 * SIMPLEX_NOISE_GLSL + CURL_NOISE_GLSL + DISPLACEMENT_SAMPLER_GLSL in that
 * order — exported as a function specifically so "which order do these go
 * in" is answered once, here, rather than every consumer having to get it
 * right independently (the exact failure mode §07's own text warns about:
 * "the second copy would be written by someone reading the first," and
 * getting the include order wrong is the most likely way that second copy
 * would be subtly broken).
 *
 * `options.curl`/`options.displacement` default to true — a caller using
 * only plain simplex noise (dissolve's `noise` transition, not `liquid`)
 * may pass `{ curl: false, displacement: false }` to skip compiling GLSL
 * it never calls, trimming shader compile time slightly. Never skips
 * SIMPLEX_NOISE_GLSL itself — every other chunk here depends on it.
 */
export function composeNoiseGLSL(options: { curl?: boolean; displacement?: boolean } = {}): string {
  const { curl = true, displacement = true } = options
  let source = SIMPLEX_NOISE_GLSL
  if (curl) source += CURL_NOISE_GLSL
  if (displacement) source += DISPLACEMENT_SAMPLER_GLSL
  return source
}
