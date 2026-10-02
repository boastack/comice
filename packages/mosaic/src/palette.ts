/**
 * @comice/mosaic/palette
 * ─────────────────────────────────────────────────────────────────────────────
 * Turns spec's `palette: string[]` ("brand colours") into what the shader
 * reads: sRGB triples, sorted darkest to lightest, as one flat array.
 *
 * Accepts hex (#rgb, #rgba, #rrggbb, #rrggbbaa) and rgb()/rgba() directly.
 * Anything else CSS understands (named colours, hsl(), oklch()...) goes
 * through the browser's own parser via a computed style, so mosaic never
 * re-implements CSS colour syntax.
 */

type RGB = [number, number, number]

function parseDirect(input: string): RGB | null {
  const value = input.trim().toLowerCase()
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(value)
  if (hex) {
    const h = hex[1]!
    const full = h.length <= 4 ? [...h].map((c) => c + c).join('') : h
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255) as RGB
  }
  const rgb = /^rgba?\(\s*([\d.]+%?)[\s,]+([\d.]+%?)[\s,]+([\d.]+%?)/.exec(value)
  if (rgb) {
    return [rgb[1]!, rgb[2]!, rgb[3]!].map((c) => (c.endsWith('%') ? parseFloat(c) / 100 : parseFloat(c) / 255)) as RGB
  }
  return null
}

function parseViaBrowser(input: string): RGB | null {
  if (typeof document === 'undefined' || !document.body) return null
  const probe = document.createElement('span')
  probe.style.color = input
  if (!probe.style.color) return null // the browser rejected it
  document.body.appendChild(probe)
  const computed = getComputedStyle(probe).color
  probe.remove()
  return parseDirect(computed)
}

/** Parses one CSS colour to sRGB 0..1, or throws naming the bad value. */
export function parseColor(input: string): RGB {
  const rgb = parseDirect(input) ?? parseViaBrowser(input)
  if (!rgb) throw new Error(`[comice] mosaic(): '${input}' in \`palette\` is not a colour.`)
  return rgb
}

/** Relative luminance, for ordering darkest to lightest. */
function luminance([r, g, b]: RGB): number {
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/** Brand colours as flat sRGB triples, darkest first. Needs at least two:
 *  every palette fill maps darkness to one end and lightness to the other. */
export function buildPalette(colors: readonly string[]): Float32Array {
  if (colors.length < 2) {
    throw new Error('[comice] mosaic(): a `palette` colour list needs at least two colours (darkest and lightest).')
  }
  const sorted = colors.map(parseColor).sort((a, b) => luminance(a) - luminance(b))
  return new Float32Array(sorted.flat())
}
