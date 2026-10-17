export type GlassOptions = { width?: number; refraction?: number; fringe?: number; sheen?: number; /** Signed directional rim lighting; default off. */ rim?: number }
export type OutlineOptions = {
  /** A solid stroke (default) or the reference's additive, soft edge sheen. */
  style?: 'stroke' | 'sheen'
  /** CSS px; sheen defaults to .012 of stage height, matching the reference. */
  width?: number
  color?: string
  /** Stroke opacity or sheen intensity. Defaults to 1 for stroke, .45 for sheen. */
  opacity?: number
}
export type SurfaceOptions = { glass?: GlassOptions | false; outline?: OutlineOptions | false }

function color(value: string): number[] {
  if (!/^#[\da-f]{6}$/i.test(value)) throw new Error('[comice] Outline color must be a six-digit hex color.')
  return [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16) / 255)
}
export function validateSurface(options: SurfaceOptions): void {
  for (const group of [options.glass, options.outline]) {
    if (group === undefined || group === false) continue
    if (typeof group !== 'object' || group === null || Array.isArray(group)) throw new TypeError('[comice] Surface settings must be false or a settings object.')
    const allowed = group === options.outline ? ['style', 'width', 'color', 'opacity'] : ['width', 'refraction', 'fringe', 'sheen', 'rim']
    for (const key of Object.keys(group)) if (!allowed.includes(key)) throw new Error(`[comice] Unsupported surface option: ${key}.`)
    for (const [key, value] of Object.entries(group)) {
      if (key === 'style' && group === options.outline) {
        if (!['stroke', 'sheen'].includes(value as string)) throw new Error('[comice] Outline style must be stroke or sheen.')
        continue
      }
      if (key === 'color') { color(value as string); continue }
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new RangeError(`[comice] Surface ${key} must be a finite nonnegative number.`)
    }
  }
  if (options.outline && (options.outline.opacity ?? 1) > 1) throw new RangeError('[comice] Outline opacity must be in [0, 1].')
}

/** Viscose's circular glass profile, applied to the actual moving silhouette.
 * Its inward sampling bend and chromatic fringe are independent of the stroke. */
export function surfaceGLSL(options: SurfaceOptions): string {
  const glass = options.glass && (options.glass.width ?? 24) > 0 ? options.glass : undefined
  const outline = options.outline && (options.outline.width ?? 1.5) > 0 ? options.outline : undefined
  if (!glass && !outline) return `
vec4 shadeSurface(vec2 uv, float distance, float alpha) {
  vec4 media = texture(u_media, clamp(uv, 0.0, 1.0));
  float a = alpha * media.a;
  return vec4(media.rgb * a, a);
}
`
  const rgb = color(outline?.color ?? '#ffffff').map((v) => v.toFixed(6)).join(', ')
  const sheen = outline?.style === 'sheen'
  const width = outline?.width === undefined && sheen ? '0.012' : `${(outline?.width ?? 1.5).toFixed(6)} / u_resolution.y`
  const opacity = (outline?.opacity ?? (sheen ? .45 : 1)).toFixed(6)
  return `
vec4 shadeSurface(vec2 uv, float distance, float alpha) {
  vec2 gradient = vec2(dFdx(distance), dFdy(distance));
  vec2 normal = gradient / max(length(gradient), 0.00001);
  float lip = max(${(glass?.width ?? 24).toFixed(6)} / u_resolution.y, 0.00001);
  float t = clamp(1.0 + distance / lip, 0.0, 1.0);
  float bend = ${glass ? '1.0 - sqrt(max(0.0, 1.0 - t * t))' : '0.0'};
  vec2 safeUv = clamp(uv - normal * bend * ${(glass?.refraction ?? 12).toFixed(6)} / u_resolution, 0.0, 1.0);
  vec2 fringe = normal * bend * ${(glass?.fringe ?? 1.5).toFixed(6)} / u_resolution;
  vec4 media = texture(u_media, safeUv);
  vec3 color = ${glass && (glass.fringe ?? 1.5) > 0 ? 'vec3(texture(u_media, clamp(safeUv + fringe, 0.0, 1.0)).r, media.g, texture(u_media, clamp(safeUv - fringe, 0.0, 1.0)).b)' : 'media.rgb'};
  color += bend * ${(glass?.sheen ?? .12).toFixed(6)};
  color += bend * bend * ${(glass?.rim ?? 0).toFixed(6)} * dot(normal, vec2(-0.7071, 0.7071));
  float aa = max(fwidth(distance), 0.5 / u_resolution.y);
  float stroke = ${outline ? sheen ? `(1.0 - smoothstep(0.0, max(${width}, 0.00001), abs(distance))) * ${opacity}` : `(1.0 - smoothstep(${width} - aa, ${width} + aa, -distance)) * ${opacity}` : '0.0'};
  ${sheen ? `color += vec3(${rgb}) * stroke;` : `color = mix(color, vec3(${rgb}), stroke);`}
  float a = alpha * media.a;
  return vec4(color * a, a);
}
`
}
