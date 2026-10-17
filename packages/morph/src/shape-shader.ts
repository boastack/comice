import { surfaceGLSL, type SurfaceOptions } from './surface.js'

export type JoinOptions = {
  /** Growing midpoint drops from the supplied liquid-frame reference (default),
   * or tapered slabs. Both use the caller's SVG component centers. */
  style?: 'metaball' | 'slab'
  /** Neighbor centers in top-left normalized coordinates, ordered along the connection. */
  points?: readonly (readonly [number, number])[]
  /** Initial radius/half-width in CSS px. The default metaball radius is 6/688
   * of stage height (the supplied reference); slab infers thickness from the
   * supplied component fields, with a 6 CSS px minimum. */
  width?: number
  /** Slab narrowing at the middle, 0..1. Default .35. */
  pinch?: number
  /** Slab downward droop in CSS px. Default 0. */
  sag?: number
  /** Slab rounded union at the attachments, CSS px. Default 8. */
  fillet?: number
  /** Separation thinning exponent; slab only. Default .4. */
  thin?: number
  /** Subtract CSS px from a fading slab so no hairline remains. Default 2.9. */
  dissolve?: number
}

// The shader license notice is retained in this package's LICENSE.
// A swept slab keeps flat silhouettes flat as neighbors fuse.
export const BRIDGE_GLSL = `
float sdBridge(vec2 point, vec2 a, vec2 b, float rEnd, float rMid, float sag) {
  vec2 span = b - a;
  float len = length(span);
  if (len < 0.00001) return 1000.0;
  vec2 dir = span / len, normal = vec2(-dir.y, dir.x);
  vec2 q = point - (a + b) * .5;
  float along = dot(q, dir), across = dot(q, normal);
  float h = clamp(along / len + .5, 0.0, 1.0);
  float bell = sin(3.14159265 * h);
  across += sag * bell * normal.y;
  float radius = mix(rMid, rEnd, pow(1.0 - bell, 1.7));
  return max(abs(along) - len * .5, abs(across) - radius);
}
float smoothUnion(float a, float b, float k) {
  if (k <= .00001) return min(a, b);
  float h = clamp(.5 + .5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}
// The matching smooth maximum. A hard max() leaves a kink in the shape's
// distance field where its two operands cross, and the glass and sheen
// shading read that kink as a bright line running inside the edge.
float smoothMax(float a, float b, float k) {
  return -smoothUnion(-a, -b, k);
}
`

export function shapeFragmentShader(options: SurfaceOptions & { hasFromMask?: boolean; textTransition?: boolean; signedMask?: boolean; direction?: 'forward' | 'reverse'; join?: JoinOptions | false; liquid?: number; liquidSheen?: number; cursorFollow?: boolean | { offset?: number; zoom?: number }; bend?: boolean | { x?: number; y?: number }; interaction?: { radius?: number; softness?: number; wake?: number; decay?: number } | boolean }): string {
  const join = options.join || undefined
  // Bend: where the shape is read is shifted by the scroll velocity, an arch
  // along x and a pinch along y, so the media stays put while the shape flexes.
  // Media parallax: a constant offset and zoom, so it follows the pointer from
  // the first frame to the last, like legacy's .035 offset at 95%.
  const follow = options.cursorFollow === false ? null : { offset: 0.035, zoom: 0.95, ...(typeof options.cursorFollow === 'object' ? options.cursorFollow : {}) }
  const bend = options.bend ? { y: 0.028, x: 0.014, ...(typeof options.bend === 'object' ? options.bend : {}) } : null
  const bendGLSL = bend ? `// Keep the deformation inside the media's domain, with exact endpoints.
  float bendPhase = 4.0 * p * (1.0 - p);
  float bendVelocity = clamp(u_velocity, -1.0, 1.0) * bendPhase;
  vec2 envelope = 4.0 * v_uv * (1.0 - v_uv);
  float arch = sin(v_uv.x * 3.14159265);
  float archY = (v_uv.y - .5) + arch * bendVelocity * ${bend.y.toFixed(6)} * envelope.y;
  float pinch = cos(archY * 6.2831853);
  vec2 displacement = vec2(pinch * bendVelocity * ${bend.x.toFixed(6)} / aspect, arch * bendVelocity * ${bend.y.toFixed(6)}) * envelope;
  vec2 room = min(v_uv, 1.0 - v_uv) * .8;
  vec2 suv = v_uv + clamp(displacement, -room, room);
  ` : 'vec2 suv = v_uv;\n  '
  const sampleDistance = (sampler: string, uv: string, scale: string) => options.signedMask
    ? `texture(${sampler}, ${uv}).r * ${scale}`
    : `(texture(${sampler}, ${uv}).r - .5) * 2.0 * ${scale}`
  const metaball = !!join && join.style !== 'slab'
  const links = metaball ? `
  // The supplied liquid-frame reference: midpoint circles, then one smooth
  // union with the shapes, bounded by their combined silhouettes so growing
  // drops cannot push an outer edge beyond the caller's SVG or CSS shape.
  if (u_joinCount > 1 && p > 0.0 && p < 1.0) {
    float jp = u_joinFrom ? p : 1.0 - p;
    float startDistance = u_joinFrom ? dFrom : dTo;
    float endDistance = u_joinFrom ? dTo : dFrom;
    float pRope = smoothstep(0.0, 0.15, jp);
    float pMerge = smoothstep(0.10, 0.90, jp);
    float pFinal = smoothstep(0.85, 1.0, jp);
    float rDrop = mix(${join?.width === undefined ? '(6.0 / 688.0)' : `${join.width.toFixed(6)} * px`}, 0.55, pMerge) * pRope;
    float dDrops = 1000000.0;
    for (int i = 1; i < 32; i++) {
      if (i >= u_joinCount) break;
      vec2 midpoint = ((u_joinPoints[i - 1] + u_joinPoints[i]) * .5 - .5) * vec2(aspect, -1.0);
      dDrops = min(dDrops, length(st - midpoint) - rDrop);
    }
    float gooeyK = mix(0.09, 0.002, pow(pMerge, 2.0)) * pRope + 0.001;
    float dLiquid = smoothUnion(mix(startDistance, endDistance, pMerge), dDrops, gooeyK);
    float keepNow = dKeep;
    distance = smoothMax(mix(dLiquid, endDistance, pFinal), keepNow, keep);
    sheenGain = pRope * (1.0 - pFinal) * ${(options.liquidSheen ?? .45).toFixed(6)};
  }` : join ? `
  if (p > 0.0 && p < 1.0) for (int i = 1; i < 32; i++) {
    if (i >= u_joinCount) break;
    vec2 a = (u_joinPoints[i - 1] - .5) * vec2(aspect, -1.0);
    vec2 b = (u_joinPoints[i] - .5) * vec2(aspect, -1.0);
    vec2 middleUV = vec2((u_joinPoints[i - 1].x + u_joinPoints[i].x) * .5, 1.0 - (u_joinPoints[i - 1].y + u_joinPoints[i].y) * .5);
    float fromGap = ${options.hasFromMask ? sampleDistance('u_fromMask', 'middleUV', 'u_fromScale') : 'frameDistance((middleUV - .5) * vec2(aspect, 1.0), vec2(aspect * .5, .5), u_sourceRadius * px)'};
    float toGap = ${sampleDistance('u_mask', 'middleUV', 'u_maskScale')};
    float separation = clamp(max(mix(fromGap, toGap, p), 0.0) / max(u_joinFrom ? fromGap : toGap, px), 0.0, 1.0);
    // Read thickness from the caller's component fields, rather than assuming cards.
    vec2 aUV = vec2(u_joinPoints[i - 1].x, 1.0 - u_joinPoints[i - 1].y);
    vec2 bUV = vec2(u_joinPoints[i].x, 1.0 - u_joinPoints[i].y);
    float aDepth = u_joinFrom ? ${sampleDistance('u_fromMask', 'aUV', 'u_fromScale')} : ${sampleDistance('u_mask', 'aUV', 'u_maskScale')};
    float bDepth = u_joinFrom ? ${sampleDistance('u_fromMask', 'bUV', 'u_fromScale')} : ${sampleDistance('u_mask', 'bUV', 'u_maskScale')};
    float thickness = ${join.width === undefined ? 'max(6.0 * px, min(-aDepth, -bDepth))' : `${join.width.toFixed(6)} * px`};
    float rEnd = thickness * pow(1.0 - separation, ${(join.thin ?? .4).toFixed(6)}) - ${(join.dissolve ?? 2.9).toFixed(6)} * px;
    float rMid = rEnd * (1.0 - ${(join.pinch ?? .35).toFixed(6)} * smoothstep(0.0, .7, separation));
    float fillet = min(${((join.fillet ?? 8) * (options.liquid ?? .5)).toFixed(6)} * px * smoothstep(0.0, .35, separation), max(rMid, 0.0) * 1.5);
    distance = smoothUnion(distance, max(sdBridge(st, a, b, rEnd, rMid, ${(join.sag ?? 0).toFixed(6)} * px * pow(separation, 1.5)), u_joinFrom ? dTo : dFrom), fillet);
  }` : ''
  return `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform vec2 u_resolution;
uniform float u_progress;
uniform vec2 u_mouse;
uniform float u_velocity;
${follow ? 'uniform float u_follow; // 0 at the handoff from the media, easing to 1\n' : ''}uniform vec4 u_interaction; // top-left UV pointer, presence, wake
uniform float u_time;
uniform float u_mediaAspect;
uniform sampler2D u_media;
uniform sampler2D u_mask;
uniform sampler2D u_fromMask;
uniform float u_maskScale;
uniform float u_fromScale;
uniform float u_sourceRadius;
uniform vec2 u_joinPoints[32];
uniform int u_joinCount;
uniform bool u_joinFrom;
${BRIDGE_GLSL}
${surfaceGLSL(options)}
${options.textTransition ? `// Filter the distance field during text interpolation, not the final alpha.
// This rounds competing glyph contours without a blurry overlay or soft endpoints.
float filteredTextDistance(sampler2D field, vec2 uv, vec2 stepUV, float scale) {
  float value = texture(field, uv).r * .25;
  value += (texture(field, uv + vec2(stepUV.x, 0.0)).r + texture(field, uv - vec2(stepUV.x, 0.0)).r
    + texture(field, uv + vec2(0.0, stepUV.y)).r + texture(field, uv - vec2(0.0, stepUV.y)).r) * .125;
  value += (texture(field, uv + stepUV).r + texture(field, uv - stepUV).r
    + texture(field, uv + vec2(stepUV.x, -stepUV.y)).r + texture(field, uv + vec2(-stepUV.x, stepUV.y)).r) * .0625;
  return ${options.signedMask ? 'value' : '(value - .5) * 2.0'} * scale;
}` : ''}
float frameDistance(vec2 point, vec2 halfSize, float radius) {
  vec2 q = abs(point) - halfSize + radius;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - radius;
}
void main() {
  float aspect = u_resolution.x / u_resolution.y;
  float px = 1.0 / u_resolution.y;
  float p = clamp(${options.direction === 'reverse' ? '1.0 - u_progress' : 'u_progress'}, 0.0, 1.0);
  ${bendGLSL}vec2 st = (suv - .5) * vec2(aspect, 1.0);
  float dFrom = ${options.hasFromMask ? options.signedMask ? 'texture(u_fromMask, suv).r * u_fromScale' : '(texture(u_fromMask, suv).r - .5) * 2.0 * u_fromScale' : 'frameDistance(st, vec2(aspect * .5, .5), u_sourceRadius * px)'};
  float dTo = ${options.signedMask ? 'texture(u_mask, suv).r * u_maskScale' : '(texture(u_mask, suv).r - .5) * 2.0 * u_maskScale'};
  float phase = sin(p * 3.14159265);
  ${options.textTransition ? `if (p > 0.0 && p < 1.0) {
    float radius = min(8.0, u_resolution.x * .008) * phase * phase;
    vec2 stepUV = vec2(radius) / u_resolution;
    dFrom = filteredTextDistance(u_fromMask, suv, stepUV, u_fromScale);
    dTo = filteredTextDistance(u_mask, suv, stepUV, u_maskScale);
  }` : ''}
  // The union of everything the shape may occupy; the surface is kept inside it.
  float dKeep = min(dFrom, dTo);
  // How softly the shape is kept inside the union of its two endpoints. It
  // scales with phase, so at progress 0 and 1 both supplied shapes are exact.
  float keep = 16.0 * px * phase;
  float distance = mix(dFrom, dTo, p);
  float liquidSheen = 0.0;
  float sheenGain = 0.0; // set by the join; applied to the FINAL surface below
  ${links}
  ${metaball ? '' : `distance += sin(v_uv.x * 19.0 + p * 8.0) * sin(v_uv.y * 23.0 - p * 5.0)
    * ${(Math.max(0, Math.min(1, options.liquid ?? .5))).toFixed(6)} * phase * (1.0 + abs(u_velocity) * 3.0) * px;`}
  ${join && !metaball ? `// Keep the joining geometry within the union of the supplied silhouettes.
  distance = smoothMax(distance, dKeep, keep);` : ''}
  ${options.interaction ? `
  float toPointer = length((v_uv - vec2(u_interaction.x, 1.0 - u_interaction.y)) * vec2(aspect, 1.0));
  float reach = ${(typeof options.interaction === 'object' ? options.interaction.radius ?? 160 : 160).toFixed(6)} * px;
  float influence = (1.0 - smoothstep(0.0, reach, toPointer)) * u_interaction.z * phase;
  distance = mix(distance, smoothUnion(dFrom, dTo, ${(typeof options.interaction === 'object' ? options.interaction.softness ?? 18 : 18).toFixed(6)} * px), influence * influence);
  distance += sin(toPointer / px * .05 - u_time * 7.0) * ${(typeof options.interaction === 'object' ? options.interaction.wake ?? 3 : 3).toFixed(6)} * px * u_interaction.w * phase * exp(-toPointer / reach);
  // Interaction affects the transition without changing either supplied endpoint.
  distance = smoothMax(distance, dKeep, keep);` : ''}
  // The sheen follows the final surface. It used to be read from the surface
  // before the pointer reshaped it, so on hover the edge moved and a bright
  // line stayed behind, floating inside the shape.
  liquidSheen = (1.0 - smoothstep(0.0, 0.012, abs(distance))) * sheenGain;
  float aa = clamp(fwidth(distance), .5 * px, 2.0 * px);
  float alpha = 1.0 - smoothstep(-aa, aa, distance);
  vec2 cover = vec2(1.0);
  if (u_mediaAspect > aspect) cover.x = aspect / u_mediaAspect;
  else cover.y = u_mediaAspect / aspect;
  vec2 uv = (v_uv - .5) * cover${follow ? ` * mix(1.0, ${follow.zoom.toFixed(6)}, u_follow)` : ''} + .5${follow ? ` - u_mouse * ${follow.offset.toFixed(6)} * u_follow` : ''};
  vec2 crop = cover${follow ? ` * mix(1.0, ${follow.zoom.toFixed(6)}, u_follow)` : ''};
  vec2 margin = max(vec2(0.0), (1.0 - crop) * .5);
  uv = (v_uv - .5) * crop + .5 + clamp(uv - ((v_uv - .5) * crop + .5), -margin, margin);
  outColor = shadeSurface(uv, distance, alpha);
  outColor.rgb += vec3(liquidSheen) * outColor.a;
}
`
}
