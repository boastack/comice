/**
 * @comice/seed/blurhash
 * ─────────────────────────────────────────────────────────────────────────────
 * A from-scratch decoder for the BlurHash format (Wolt's public spec,
 * https://blurha.sh, base83-encoded DCT coefficients). Same role as
 * thumbhash.ts — decode only, index.ts renders the result as the
 * placeholder background. The base83 alphabet and DCT reconstruction below
 * are BlurHash's own fixed public algorithm, not something with room to
 * diverge, so this is a direct implementation of that one spec.
 */

const BASE83_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~'

function decodeBase83(str: string): number {
  let value = 0
  for (const char of str) {
    const index = BASE83_CHARS.indexOf(char)
    if (index === -1) throw new Error('[comice] seed(): blurhash contains an invalid character.')
    value = value * 83 + index
  }
  return value
}

function signPow(value: number, exp: number): number {
  return Math.sign(value) * Math.abs(value) ** exp
}

function srgbToLinear(value: number): number {
  const v = value / 255
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}

function linearToSrgb(value: number): number {
  const v = Math.max(0, Math.min(1, value))
  return Math.round((v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055) * 255)
}

export type DecodedBlurHash = {
  width: number
  height: number
  rgba: Uint8ClampedArray
}

/**
 * Decodes a BlurHash string into an RGBA bitmap at `width`x`height`.
 * Throws on a hash shorter than the fixed 6-character header, or whose
 * declared component grid doesn't match its actual encoded length — a
 * malformed hash is an upstream-generation error, matching thumbhash.ts's
 * same "fail loudly on malformed input" choice.
 */
export function blurHashToRGBA(hash: string, width: number, height: number): DecodedBlurHash {
  if (hash.length < 6) {
    throw new Error('[comice] seed(): blurhash is too short to be valid.')
  }

  const sizeFlag = decodeBase83(hash[0]!)
  const numX = (sizeFlag % 9) + 1
  const numY = Math.floor(sizeFlag / 9) + 1

  const expectedLength = 4 + 2 * numX * numY
  if (hash.length !== expectedLength) {
    throw new Error(`[comice] seed(): blurhash length ${hash.length} does not match expected ${expectedLength} for a ${numX}x${numY} component grid.`)
  }

  const quantizedMaxValue = decodeBase83(hash[1]!)
  const maxValue = (quantizedMaxValue + 1) / 166

  const colors: Array<[number, number, number]> = []
  const dc = decodeBase83(hash.slice(2, 6))
  colors.push([srgbToLinear((dc >> 16) & 255), srgbToLinear((dc >> 8) & 255), srgbToLinear(dc & 255)])

  for (let i = 1; i < numX * numY; i++) {
    const value = decodeBase83(hash.slice(4 + i * 2, 4 + i * 2 + 2))
    colors.push([
      signPow(Math.floor(value / (19 * 19)) / 9 - 9, 2) * maxValue,
      signPow((Math.floor(value / 19) % 19) / 9 - 9, 2) * maxValue,
      signPow((value % 19) / 9 - 9, 2) * maxValue,
    ])
  }

  const rgba = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0
      let g = 0
      let b = 0
      for (let j = 0; j < numY; j++) {
        for (let i = 0; i < numX; i++) {
          const basis = Math.cos((Math.PI * x * i) / width) * Math.cos((Math.PI * y * j) / height)
          const color = colors[j * numX + i]!
          r += color[0] * basis
          g += color[1] * basis
          b += color[2] * basis
        }
      }
      const idx = (y * width + x) * 4
      rgba[idx] = linearToSrgb(r)
      rgba[idx + 1] = linearToSrgb(g)
      rgba[idx + 2] = linearToSrgb(b)
      rgba[idx + 3] = 255
    }
  }

  return { width, height, rgba }
}
