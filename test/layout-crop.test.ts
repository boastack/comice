/**
 * test/layout-crop — layout's `crop` mode
 * ─────────────────────────────────────────────────────────────────────────────
 * The spec names `crop` among layout's modes without defining it; the
 * agreed reading is a focal-point crop: the media crops to an aspect ratio
 * and keeps a focal point in frame — centred where the image allows,
 * clamped at its edges. Verified in Chromium at three container widths.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { comice, type ComiceHandle } from 'comice'
import { focalCropPosition, parseAspect } from '../packages/layout/src/crop.js'
import { layout } from '../packages/layout/src/index.js'

describe('focalCropPosition', () => {
  it('centres the focal point when the image is large enough', () => {
    // 1000x1000 into 200x200: scale 0.2, image 200x200 — nothing to move.
    expect(focalCropPosition(1000, 1000, 200, 200, [0.5, 0.5])).toEqual({ x: 0, y: 0 })
    // 2000x1000 into 200x200: scale 0.2 -> 400x200. Focal at 0.6 -> 240px;
    // centred means x = 100 - 240 = -140 (within the -200..0 range).
    expect(focalCropPosition(2000, 1000, 200, 200, [0.6, 0.5])).toEqual({ x: -140, y: 0 })
  })

  it('clamps at the image edges so no empty band shows', () => {
    // Focal at 0.95 would need x = 100 - 380 = -280; the image ends at -200.
    expect(focalCropPosition(2000, 1000, 200, 200, [0.95, 0.5]).x).toBe(-200)
    // And at the near edge.
    expect(focalCropPosition(2000, 1000, 200, 200, [0.02, 0.5]).x).toBe(0)
  })

  it('works vertically too', () => {
    // 1000x2000 into 200x200: image 200x400; focal y 0.25 -> 100px, centred
    // means y = 100 - 100 = 0.
    expect(focalCropPosition(1000, 2000, 200, 200, [0.5, 0.25])).toEqual({ x: 0, y: 0 })
    expect(focalCropPosition(1000, 2000, 200, 200, [0.5, 0.6]).y).toBe(-140)
  })
})

describe('parseAspect', () => {
  it('reads ratios and numbers into CSS aspect-ratio', () => {
    expect(parseAspect('4/5')).toBe('4 / 5')
    expect(parseAspect(' 16 / 9 ')).toBe('16 / 9')
    expect(parseAspect('2')).toBe('2 / 1')
    expect(parseAspect(1.5)).toBe('1.5')
  })

  it('rejects anything that is not a positive ratio', () => {
    expect(parseAspect('wide')).toBeNull()
    expect(parseAspect('0/1')).toBeNull()
    expect(parseAspect(0)).toBeNull()
    expect(parseAspect(Number.NaN)).toBeNull()
  })
})

describe("layout({ mode: 'crop' })", () => {
  let handle: ComiceHandle | null = null
  afterEach(() => {
    handle?.destroy()
    handle = null
    document.body.innerHTML = ''
  })

  function img(natural: [number, number] | null, box: [number, number]): HTMLImageElement {
    const el = document.createElement('img')
    Object.defineProperty(el, 'naturalWidth', { value: natural?.[0] ?? 0, configurable: true })
    Object.defineProperty(el, 'naturalHeight', { value: natural?.[1] ?? 0, configurable: true })
    Object.defineProperty(el, 'clientWidth', { value: box[0], configurable: true })
    Object.defineProperty(el, 'clientHeight', { value: box[1], configurable: true })
    document.body.appendChild(el)
    return el
  }

  it('sets the aspect ratio, covers the box, and centres the focal point', () => {
    const el = img([2000, 1000], [200, 200])
    handle = (comice(el) as ComiceHandle).use(layout({ mode: 'crop', aspect: '1/1', focal: [0.6, 0.5] }))
    expect(el.style.aspectRatio).toBe('1 / 1')
    expect(el.style.objectFit).toBe('cover')
    expect(el.style.objectPosition).toBe('-140px 0px')
  })

  it('without an aspect, crops within the box it already has', () => {
    const el = img([2000, 1000], [200, 200])
    handle = (comice(el) as ComiceHandle).use(layout({ mode: 'crop' }))
    expect(el.style.aspectRatio).toBe('')
    expect(el.style.objectPosition).toBe('-100px 0px') // default focal: the centre
  })

  it('before the media has a size, keeps the focal point in frame with percentages — then centres it on load', () => {
    const el = img(null, [200, 200])
    handle = (comice(el) as ComiceHandle).use(layout({ mode: 'crop', focal: [0.6, 0.3] }))
    expect(el.style.objectPosition).toBe('60% 30%')
    Object.defineProperty(el, 'naturalWidth', { value: 2000 })
    Object.defineProperty(el, 'naturalHeight', { value: 1000 })
    el.dispatchEvent(new Event('load'))
    expect(el.style.objectPosition).toBe('-140px 0px')
  })

  it('reads a video\'s size from videoWidth/videoHeight', () => {
    const video = document.createElement('video')
    Object.defineProperty(video, 'videoWidth', { value: 2000 })
    Object.defineProperty(video, 'videoHeight', { value: 1000 })
    Object.defineProperty(video, 'clientWidth', { value: 200 })
    Object.defineProperty(video, 'clientHeight', { value: 200 })
    document.body.appendChild(video)
    handle = (comice(video) as ComiceHandle).use(layout({ mode: 'crop', focal: [0.6, 0.5] }))
    expect(video.style.objectPosition).toBe('-140px 0px')
  })

  it('teardown restores the media\'s own styles', () => {
    const el = img([2000, 1000], [200, 200])
    el.style.objectFit = 'contain'
    handle = (comice(el) as ComiceHandle).use(layout({ mode: 'crop', aspect: 1 }))
    handle.destroy()
    handle = null
    expect(el.style.objectFit).toBe('contain')
    expect(el.style.aspectRatio).toBe('')
    expect(el.style.objectPosition).toBe('')
  })

  it("focal 'subject' needs vision, and a bad aspect is an error — both at construction", () => {
    expect(() => layout({ mode: 'crop', focal: 'subject' })).toThrow(/needs @comice\/vision/)
    expect(() => layout({ mode: 'crop', aspect: 'wide' })).toThrow(/not a ratio/)
  })
})
