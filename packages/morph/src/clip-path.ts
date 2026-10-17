import type { RasterizedMaskSource } from 'comice/gl'

export type ClipPathShape = { clipPath: string }
export type ShapeMask = RasterizedMaskSource | ((width: number, height: number) => RasterizedMaskSource)
const fail = (detail: string): never => { throw new Error(`[comice] Invalid or unsupported clip-path: ${detail}`) }

// Split only outside parentheses and quoted SVG path strings.
function split(value: string, separator: ',' | ' ' | '/'): string[] {
  const result: string[] = []
  let depth = 0, quote = '', start = 0
  for (let i = 0; i < value.length; i++) {
    const c = value[i]
    if (quote) { if (c === quote) quote = ''; continue }
    if (c === '"' || c === "'") { quote = c; continue }
    if (c === '(') depth++
    if (c === ')') depth--
    if (depth < 0) fail(value)
    if (!depth && (separator === ' ' ? /\s/.test(c) : c === separator)) {
      if (!value.slice(start, i).trim() && separator !== ' ') fail(value)
      if (value.slice(start, i).trim()) result.push(value.slice(start, i).trim())
      start = i + 1
    }
  }
  if (depth || quote) fail(value)
  if (start > 0 && !value.slice(start).trim() && separator !== ' ') fail(value)
  if (value.slice(start).trim()) result.push(value.slice(start).trim())
  return result
}

function length(value: string, basis: number): number {
  const simple = /^([+-]?(?:\d+\.?\d*|\.\d+))(px|%)?$/i.exec(value)
  if (simple) {
    const n = Number(simple[1])
    if (!Number.isFinite(n)) fail(value)
    if (!simple[2] && n !== 0) fail(`length needs px or %: ${value}`)
    return simple[2] === '%' ? n * basis / 100 : n
  }
  // CSS calc's additive length-percentage expressions. Multiplication,
  // variables and other units fail explicitly instead of changing geometry.
  if (/^calc\(/i.test(value) && value.endsWith(')')) {
    const terms = value.slice(5, -1).trim().match(/[+-]?\s*(?:\d+\.?\d*|\.\d+)(?:px|%)/gi)
    if (terms?.slice(1).some(term => !/^[+-]/.test(term.trim()))) fail(value)
    if (!terms || terms.join('').replace(/\s/g, '') !== value.slice(5, -1).replace(/\s/g, '')) fail(value)
    return terms!.reduce((sum, term) => sum + length(term.replace(/\s/g, ''), basis), 0)
  }
  return fail(value)
}
function four<T>(values: T[]): T[] {
  if (!values.length || values.length > 4) fail('expected one to four values')
  return [values[0], values[1] ?? values[0], values[2] ?? values[0], values[3] ?? values[1] ?? values[0]]
}
function position(value: string | undefined, w: number, h: number): [number, number] {
  let parts = split(value ?? 'center', ' ')
  if (parts.length > 2) fail('positions with edge offsets are unsupported')
  if (parts.length === 1) parts = ['top', 'bottom'].includes(parts[0]) ? ['center', parts[0]] : [parts[0], 'center']
  if (['top', 'bottom'].includes(parts[0]) || ['left', 'right'].includes(parts[1])) parts.reverse()
  const axis = (s: string, size: number, low: string, high: string) => s === 'center' ? size / 2 : s === low ? 0 : s === high ? size : length(s, size)
  return [axis(parts[0], w, 'left', 'right'), axis(parts[1], h, 'top', 'bottom')]
}
function ellipse(cx: number, cy: number, rx: number, ry: number): string {
  if (rx < 0 || ry < 0) fail('negative radius')
  if (!rx || !ry) return 'M0 0Z'
  return `M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}Z`
}
function box(x: number, y: number, width: number, height: number, rounding: string | undefined): string {
  const w = Math.max(0, width), h = Math.max(0, height)
  let rx = [0, 0, 0, 0], ry = rx.slice()
  if (rounding) {
    const sides = split(rounding, '/')
    if (sides.length > 2) fail(rounding)
    rx = four(split(sides[0], ' ')).map(s => length(s, w))
    ry = four(split(sides[1] ?? sides[0], ' ')).map(s => length(s, h))
    if ([...rx, ...ry].some(n => n < 0)) fail('negative corner radius')
    const scale = Math.min(1, w / (rx[0] + rx[1] || 1), w / (rx[2] + rx[3] || 1), h / (ry[0] + ry[3] || 1), h / (ry[1] + ry[2] || 1))
    rx = rx.map(n => n * scale); ry = ry.map(n => n * scale)
  }
  const arc = (i: number, a: number, b: number) => rx[i] && ry[i] ? `A${rx[i]} ${ry[i]} 0 0 1 ${a} ${b}` : `L${a} ${b}`
  return `M${x + rx[0]} ${y}L${x + w - rx[1]} ${y}${arc(1, x + w, y + ry[1])}L${x + w} ${y + h - ry[2]}${arc(2, x + w - rx[2], y + h)}L${x + rx[3]} ${y + h}${arc(3, x, y + h - ry[3])}L${x} ${y + ry[0]}${arc(0, x + rx[0], y)}Z`
}

/** Preserve computed elliptical radii, including calc() with spaces. */
export function radiusPair(value: string): [string, string] {
  const values = split(value || '0px', ' ')
  if (values.length > 2) fail('invalid corner radius')
  return [values[0], values[1] ?? values[0]]
}

function validatePath(path: string): void {
  // Native CSS parses the complete SVG grammar, including packed arc flags.
  // Probe invalid syntax too: some non-browser DOM shims always return true.
  if (typeof CSS !== 'undefined' && CSS.supports('clip-path', 'path("M0 0Z")') && !CSS.supports('clip-path', 'path("M0 0X1 1")')) {
    if (!CSS.supports('clip-path', `path("${path}")`)) fail('invalid SVG path data')
    return
  }
  const tokens = path.match(/[MmZzLlHhVvCcSsQqTtAa]|[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g) ?? []
  if (tokens.join('') !== path.replace(/[\s,]/g, '') || /,[\s,]*,|[a-z]\s*,|,\s*[a-z]|,\s*$/i.test(path)) fail('invalid SVG path data')
  const counts: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 }
  for (let i = 0; i < tokens.length;) {
    const command = tokens[i++].toLowerCase(), count = counts[command]
    if (count === undefined) fail('invalid SVG command')
    const values: number[] = []
    while (i < tokens.length && !/^[a-z]$/i.test(tokens[i])) values.push(Number(tokens[i++]))
    if (values.some(v => !Number.isFinite(v)) || (count ? !values.length || values.length % count : values.length)) fail('invalid SVG command arguments')
    if (command === 'a') for (let j = 0; j < values.length; j += 7) {
      if (values[j] < 0 || values[j + 1] < 0 || ![0, 1].includes(values[j + 3]) || ![0, 1].includes(values[j + 4])) fail('invalid SVG arc')
    }
  }
}

/** Compile once, evaluate against the media's CSS box on each resize.
 * Deliberately independent of CSS.supports: path() works even on browsers
 * whose CSS interpolation cannot morph paths with different topology. */
export function compileClipPath(input: string): (w: number, h: number) => RasterizedMaskSource {
  const value = input.trim()
  const match = /^(polygon|circle|ellipse|inset|path|rect|xywh)\(([\s\S]*)\)(?:\s+border-box)?$/i.exec(value)
  if (!match) return fail(value)
  const name = match[1].toLowerCase(), body = match[2].trim()
  const compile = (w: number, h: number): RasterizedMaskSource => {
    let path: string, fillRule: CanvasFillRule = 'nonzero'
    if (name === 'path') {
      const args = split(body, ',')
      if (args.length === 2) { if (!['evenodd', 'nonzero'].includes(args[0])) fail(body); fillRule = args.shift() as CanvasFillRule }
      if (args.length !== 1 || !/^("[^"]+"|'[^']+')$/.test(args[0])) fail(body)
      path = args[0].slice(1, -1)
      if (!/^[Mm]/.test(path) || /[^MmZzLlHhVvCcSsQqTtAa\d\s.,+eE-]/.test(path)) fail('invalid SVG path data')
      validatePath(path)
    } else if (name === 'polygon') {
      const points = split(body, ',')
      if (['evenodd', 'nonzero'].includes(points[0])) fillRule = points.shift() as CanvasFillRule
      if (points.length < 3) fail('polygon needs at least three points')
      path = points.map((point, i) => {
        const pair = split(point, ' ')
        if (pair.length !== 2) fail(point)
        return `${i ? 'L' : 'M'}${length(pair[0], w)} ${length(pair[1], h)}`
      }).join('') + 'Z'
    } else if (name === 'circle' || name === 'ellipse') {
      const parts = body.split(/(?:^|\s+)at\s+/i)
      if (parts.length > 2) fail(body)
      const [cx, cy] = position(parts[1], w, h)
      const sizes = split(parts[0], ' ')
      if (sizes.length > (name === 'circle' ? 1 : 2)) fail(body)
      const radius = (s: string, size: number, c: number, basis: number) => s === 'closest-side' ? Math.min(Math.abs(c), Math.abs(size - c)) : s === 'farthest-side' ? Math.max(Math.abs(c), Math.abs(size - c)) : length(s, basis)
      if (name === 'circle') {
        const s = sizes[0] ?? 'closest-side'
        const r = ['closest-side', 'farthest-side'].includes(s) ? Math[s === 'closest-side' ? 'min' : 'max'](Math.abs(cx), Math.abs(w - cx), Math.abs(cy), Math.abs(h - cy)) : length(s, Math.hypot(w, h) / Math.SQRT2)
        path = ellipse(cx, cy, r, r)
      } else {
        if (sizes.length === 1) fail('ellipse needs two radii')
        path = ellipse(cx, cy, radius(sizes[0] ?? 'closest-side', w, cx, w), radius(sizes[1] ?? 'closest-side', h, cy, h))
      }
    } else {
      const parts = body.split(/\s+round\s+/i)
      if (parts.length > 2) fail(body)
      const values = split(parts[0], ' ')
      let x: number, y: number, bw: number, bh: number
      if (name === 'inset') {
        const sides = four(values).map((s, i) => length(s, i % 2 ? w : h))
        if (sides[0] + sides[2] > h) { const f = h / (sides[0] + sides[2]); sides[0] *= f; sides[2] *= f }
        if (sides[1] + sides[3] > w) { const f = w / (sides[1] + sides[3]); sides[1] *= f; sides[3] *= f }
        x = sides[3]; y = sides[0]; bw = w - x - sides[1]; bh = h - y - sides[2]
      } else {
        if (values.length !== 4) fail(`${name} needs four values`)
        if (name === 'xywh') {
          x = length(values[0], w); y = length(values[1], h); bw = length(values[2], w); bh = length(values[3], h)
          if (bw < 0 || bh < 0) fail('negative size')
        } else {
          const [top, right, bottom, left] = values.map((s, i) => s === 'auto' ? (i === 1 ? w : i === 2 ? h : 0) : length(s, i % 2 ? w : h))
          x = left; y = top; bw = right - left; bh = bottom - top
        }
      }
      path = box(x, y, bw, bh, parts[1])
    }
    return { type: 'shape', path, viewBox: [0, 0, w, h], fit: 'stretch', fillRule }
  }
  compile(100, 100) // Fail synchronously before mounting or loading media.
  return compile
}
