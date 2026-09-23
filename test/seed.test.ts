/**
 * test/seed.test — packages/seed/src/index.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs against happy-dom. seed never touches GL or the scheduler, so this
 * imports core from source directly (../packages/core/src), same as
 * test/spotlight.test.ts — no cross-package scheduler-singleton concern
 * applies here.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { comice, type ComiceHandle } from '../packages/core/src/index.js'
import { seed } from '../packages/seed/src/index.js'
import { installFake2DContext } from './fake-webgl2.js'

// A syntactically valid ThumbHash byte sequence, base64-encoded — built the
// same way test/seed-thumbhash.test.ts's buildHash() does, just inlined
// here since seed()'s own `hash` option takes a base64 string, not raw
// bytes.
function makeThumbHashBase64(): string {
  const bytes = new Uint8Array(10)
  let header24 = 0
  header24 |= 20 & 63
  header24 |= (32 & 63) << 6
  header24 |= (32 & 63) << 12
  header24 |= (16 & 31) << 18
  bytes[0] = header24 & 0xff
  bytes[1] = (header24 >> 8) & 0xff
  bytes[2] = (header24 >> 16) & 0xff
  let header16 = 0
  header16 |= 32 & 63
  header16 |= (32 & 63) << 6
  header16 |= (3 & 7) << 13
  bytes[3] = header16 & 0xff
  bytes[4] = (header16 >> 8) & 0xff

  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

const BASE83_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~'
function encodeBase83(value: number, length: number): string {
  let result = ''
  let v = Math.round(value)
  for (let i = 0; i < length; i++) {
    result = BASE83_CHARS[v % 83] + result
    v = Math.floor(v / 83)
  }
  return result
}
function makeBlurHash(): string {
  let hash = encodeBase83(0, 1) + encodeBase83(0, 1)
  hash += encodeBase83((128 << 16) | (128 << 8) | 128, 4)
  return hash
}

function readyImage(complete = false): HTMLImageElement {
  const img = document.createElement('img')
  Object.defineProperty(img, 'complete', { value: complete, configurable: true })
  Object.defineProperty(img, 'naturalWidth', { value: complete ? 800 : 0, configurable: true })
  return img
}

describe('seed — construction contract', () => {
  it("throws when focal is 'subject' (needs vision, not built)", () => {
    expect(() => seed({ focal: 'subject' })).toThrow()
  })

  it('does not throw with no options at all', () => {
    expect(() => seed()).not.toThrow()
  })
})

describe('seed — target contract', () => {
  it('throws for a non-media target', () => {
    const div = document.createElement('div')
    document.body.appendChild(div)
    const handle = comice(div) as ComiceHandle
    expect(() => handle.use(seed())).toThrow()
    div.remove()
  })

  it('accepts an <img> target without throwing', () => {
    const img = readyImage()
    document.body.appendChild(img)
    const handle = comice(img) as ComiceHandle
    expect(() => handle.use(seed())).not.toThrow()
    img.remove()
  })

  it('accepts a <video> target without throwing', () => {
    const video = document.createElement('video')
    document.body.appendChild(video)
    const handle = comice(video) as ComiceHandle
    expect(() => handle.use(seed())).not.toThrow()
    video.remove()
  })
})

describe('seed — focal', () => {
  it('sets object-position from an [x, y] focal point', () => {
    const img = readyImage()
    document.body.appendChild(img)
    const handle = comice(img) as ComiceHandle
    handle.use(seed({ focal: [0.2, 0.8] }))
    expect(img.style.objectPosition).toBe('20% 80%')
    img.remove()
  })

  it('defaults focal to [0.5, 0.5]', () => {
    const img = readyImage()
    document.body.appendChild(img)
    const handle = comice(img) as ComiceHandle
    handle.use(seed())
    expect(img.style.objectPosition).toBe('50% 50%')
    img.remove()
  })
})

describe('seed — placeholders', () => {
  let uninstall2D: () => void

  beforeEach(() => {
    // happy-dom has no 2D canvas implementation at all (getContext('2d')
    // is unconditionally null, same as its webgl2 behavior) — seed's
    // rgbaToDataUrl() needs a real 2D context to paint a decoded
    // thumbhash/blurhash bitmap before reading it back, so these tests
    // install the same fake gl-mask.test.ts's rasterize() tests use.
    ;({ uninstall: uninstall2D } = installFake2DContext())
  })

  afterEach(() => {
    uninstall2D()
  })

  it('thumbhash: applies a background-image placeholder and blur, then clears blur once decoded', async () => {
    const img = readyImage(false)
    document.body.appendChild(img)
    const handle = comice(img) as ComiceHandle
    handle.use(seed({ placeholder: 'thumbhash', hash: makeThumbHashBase64() }))

    expect(img.style.backgroundImage).toContain('data:image')
    expect(img.style.filter).toBe('blur(20px)')

    img.dispatchEvent(new Event('load'))
    await Promise.resolve()
    await Promise.resolve()
    expect(img.style.filter).toBe('')

    img.remove()
  })

  it('blurhash: applies a background-image placeholder', () => {
    const img = readyImage(false)
    document.body.appendChild(img)
    const handle = comice(img) as ComiceHandle
    handle.use(seed({ placeholder: 'blurhash', hash: makeBlurHash() }))
    expect(img.style.backgroundImage).toContain('data:image')
    img.remove()
  })

  it('lqip: uses the given data URI directly as the placeholder', () => {
    const img = readyImage(false)
    document.body.appendChild(img)
    const handle = comice(img) as ComiceHandle
    const dataUri = 'data:image/jpeg;base64,AAAA'
    handle.use(seed({ placeholder: 'lqip', lqip: dataUri }))
    expect(img.style.backgroundImage).toContain(dataUri)
    img.remove()
  })

  it('degrades (no throw, no placeholder) when canvas.toDataURL() throws', () => {
    const original = HTMLCanvasElement.prototype.toDataURL
    HTMLCanvasElement.prototype.toDataURL = () => {
      throw new Error('tainted canvas')
    }
    try {
      const img = readyImage(false)
      document.body.appendChild(img)
      const handle = comice(img) as ComiceHandle
      expect(() => handle.use(seed({ placeholder: 'thumbhash', hash: makeThumbHashBase64() }))).not.toThrow()
      expect(img.style.backgroundImage).toBe('')
      img.remove()
    } finally {
      HTMLCanvasElement.prototype.toDataURL = original
    }
  })

  it('no placeholder is applied when hash/lqip is missing', () => {
    const img = readyImage(false)
    document.body.appendChild(img)
    const handle = comice(img) as ComiceHandle
    handle.use(seed({ placeholder: 'thumbhash' }))
    expect(img.style.backgroundImage).toBe('')
    img.remove()
  })

  it('an already-ready target never applies (or immediately clears) blur', async () => {
    const img = readyImage(true)
    document.body.appendChild(img)
    const handle = comice(img) as ComiceHandle
    handle.use(seed({ placeholder: 'thumbhash', hash: makeThumbHashBase64() }))
    await Promise.resolve()
    await Promise.resolve()
    expect(img.style.filter).toBe('')
    img.remove()
  })

  it('a <video> target waits for loadeddata before clearing blur', async () => {
    const video = document.createElement('video')
    document.body.appendChild(video)
    const handle = comice(video) as ComiceHandle
    handle.use(seed({ placeholder: 'lqip', lqip: 'data:image/jpeg;base64,AAAA' }))
    expect(video.style.filter).toBe('blur(20px)')

    video.dispatchEvent(new Event('loadeddata'))
    await Promise.resolve()
    await Promise.resolve()
    expect(video.style.filter).toBe('')

    video.remove()
  })
})

describe('seed — priority', () => {
  it('priority: true sets loading="eager" and fetchPriority="high" on an <img>', () => {
    const img = readyImage()
    document.body.appendChild(img)
    const handle = comice(img) as ComiceHandle
    handle.use(seed({ priority: true }))
    expect(img.loading).toBe('eager')
    img.remove()
  })

  it('priority: false (default) leaves loading/fetchPriority untouched', () => {
    const img = readyImage()
    document.body.appendChild(img)
    const handle = comice(img) as ComiceHandle
    handle.use(seed())
    expect(img.loading).not.toBe('eager')
    img.remove()
  })

  it('priority has no effect on a <video> target (no throw)', () => {
    const video = document.createElement('video')
    document.body.appendChild(video)
    const handle = comice(video) as ComiceHandle
    expect(() => handle.use(seed({ priority: true }))).not.toThrow()
    video.remove()
  })
})

describe('seed — teardown', () => {
  it('restores original styles and loading/fetchPriority on destroy', () => {
    const img = readyImage()
    img.loading = 'lazy'
    document.body.appendChild(img)
    const handle = comice(img) as ComiceHandle
    handle.use(seed({ placeholder: 'lqip', lqip: 'data:image/jpeg;base64,AAAA', priority: true, focal: [0.1, 0.9] }))

    expect(img.fetchPriority).toBe('high') // setup() really did set it

    handle.destroy()

    expect(img.style.objectPosition).toBe('')
    expect(img.style.backgroundImage).toBe('')
    expect(img.style.filter).toBe('')
    expect(img.loading).toBe('lazy')
    img.remove()
  })

  it('restores a real, pre-existing fetchPriority value exactly, rather than defaulting to "auto"', () => {
    const img = readyImage()
    img.fetchPriority = 'low'
    document.body.appendChild(img)
    const handle = comice(img) as ComiceHandle
    handle.use(seed({ priority: true })) // setup() overwrites it to 'high'
    expect(img.fetchPriority).toBe('high')

    handle.destroy()

    expect(img.fetchPriority).toBe('low') // back to the real original, not 'auto'
    img.remove()
  })

  it('removes the fetchpriority attribute on teardown when it was never set before setup()', () => {
    const img = readyImage()
    document.body.appendChild(img)
    const handle = comice(img) as ComiceHandle
    handle.use(seed({ priority: true })) // setup() sets it to 'high'
    expect(img.fetchPriority).toBe('high')

    handle.destroy()

    // An IDL-reflected attribute that was never explicitly set before
    // Comice touched it comes back removed, not coerced to a new
    // explicit value ('auto') Comice never actually observed originally.
    expect(img.hasAttribute('fetchpriority')).toBe(false)
    img.remove()
  })

  it('teardown does not throw when called immediately after setup, before decode resolves', () => {
    const img = readyImage(false)
    document.body.appendChild(img)
    const handle = comice(img) as ComiceHandle
    handle.use(seed({ placeholder: 'lqip', lqip: 'data:image/jpeg;base64,AAAA' }))
    expect(() => handle.destroy()).not.toThrow()
    img.remove()
  })

  it('falls back to the load/error event path when decode() rejects', async () => {
    const img = readyImage(false)
    const originalDecode = img.decode.bind(img)
    img.decode = () => Promise.reject(new Error('decode failed'))
    document.body.appendChild(img)
    const handle = comice(img) as ComiceHandle
    handle.use(seed({ placeholder: 'lqip', lqip: 'data:image/jpeg;base64,AAAA' }))

    // decode() rejects asynchronously — let that microtask settle (arming
    // the load/error fallback listeners) before dispatching 'load'.
    await Promise.resolve()
    await Promise.resolve()
    img.dispatchEvent(new Event('load'))
    await Promise.resolve()
    await Promise.resolve()
    expect(img.style.filter).toBe('')

    img.decode = originalDecode
    img.remove()
  })

  it('falls back to the load/error event path when decode() is not a function at all', async () => {
    const img = readyImage(false)
    // @ts-expect-error — deliberately simulating an environment where
    // HTMLImageElement.prototype.decode does not exist.
    img.decode = undefined
    document.body.appendChild(img)
    const handle = comice(img) as ComiceHandle
    handle.use(seed({ placeholder: 'lqip', lqip: 'data:image/jpeg;base64,AAAA' }))

    img.dispatchEvent(new Event('load'))
    await Promise.resolve()
    await Promise.resolve()
    expect(img.style.filter).toBe('')

    img.remove()
  })

  it('a decode event arriving after teardown does not throw or touch a destroyed target', async () => {
    const img = readyImage(false)
    document.body.appendChild(img)
    const handle = comice(img) as ComiceHandle
    handle.use(seed({ placeholder: 'lqip', lqip: 'data:image/jpeg;base64,AAAA' }))
    handle.destroy()
    expect(() => img.dispatchEvent(new Event('load'))).not.toThrow()
    await Promise.resolve()
    img.remove()
  })
})
