/**
 * test/reveal-decode.test — packages/reveal/src/decode.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs against happy-dom (see /bunfig.toml preload).
 */

import { describe, expect, it } from 'bun:test'
import { waitForMediaReady } from '../packages/reveal/src/decode.js'

describe('waitForMediaReady — non-media elements', () => {
  it('resolves immediately for a plain element (nothing to decode)', async () => {
    const div = document.createElement('div')
    await expect(waitForMediaReady(div)).resolves.toBeUndefined()
  })
})

describe('waitForMediaReady — images', () => {
  it('resolves immediately when the image is already complete with real dimensions', async () => {
    const img = document.createElement('img')
    Object.defineProperty(img, 'complete', { value: true, configurable: true })
    Object.defineProperty(img, 'naturalWidth', { value: 100, configurable: true })
    await expect(waitForMediaReady(img)).resolves.toBeUndefined()
  })

  it('waits for decode() to resolve when the image is not yet complete', async () => {
    const img = document.createElement('img')
    Object.defineProperty(img, 'complete', { value: false, configurable: true })
    Object.defineProperty(img, 'naturalWidth', { value: 0, configurable: true })

    let decodeCalled = false
    img.decode = () => {
      decodeCalled = true
      return Promise.resolve()
    }

    await waitForMediaReady(img)
    expect(decodeCalled).toBe(true)
  })

  it('falls back to the load event if decode() rejects', async () => {
    const img = document.createElement('img')
    Object.defineProperty(img, 'complete', { value: false, configurable: true })
    Object.defineProperty(img, 'naturalWidth', { value: 0, configurable: true })
    img.decode = () => Promise.reject(new Error('decode failed'))

    const promise = waitForMediaReady(img)
    // Give the rejected decode() a microtask to be caught internally, then
    // fire the fallback load event.
    await Promise.resolve()
    img.dispatchEvent(new Event('load'))

    await expect(promise).resolves.toBeUndefined()
  })

  it('resolves on an error event too, rather than hanging forever', async () => {
    const img = document.createElement('img')
    Object.defineProperty(img, 'complete', { value: false, configurable: true })
    Object.defineProperty(img, 'naturalWidth', { value: 0, configurable: true })
    img.decode = () => Promise.reject(new Error('decode failed'))

    const promise = waitForMediaReady(img)
    await Promise.resolve()
    img.dispatchEvent(new Event('error'))

    await expect(promise).resolves.toBeUndefined()
  })

  it('falls back to load/error events when decode() is unavailable', async () => {
    const img = document.createElement('img')
    Object.defineProperty(img, 'complete', { value: false, configurable: true })
    Object.defineProperty(img, 'naturalWidth', { value: 0, configurable: true })
    // @ts-expect-error — simulate an environment without HTMLImageElement.decode
    img.decode = undefined

    const promise = waitForMediaReady(img)
    img.dispatchEvent(new Event('load'))
    await expect(promise).resolves.toBeUndefined()
  })
})

describe('waitForMediaReady — video', () => {
  it('resolves immediately when readyState already indicates current data', async () => {
    const video = document.createElement('video')
    Object.defineProperty(video, 'readyState', { value: 2, configurable: true }) // HAVE_CURRENT_DATA
    await expect(waitForMediaReady(video)).resolves.toBeUndefined()
  })

  it('waits for the loadeddata event when readyState is not ready yet', async () => {
    const video = document.createElement('video')
    Object.defineProperty(video, 'readyState', { value: 0, configurable: true }) // HAVE_NOTHING

    const promise = waitForMediaReady(video)
    video.dispatchEvent(new Event('loadeddata'))
    await expect(promise).resolves.toBeUndefined()
  })

  it('resolves on an error event too, rather than hanging forever', async () => {
    const video = document.createElement('video')
    Object.defineProperty(video, 'readyState', { value: 0, configurable: true })

    const promise = waitForMediaReady(video)
    video.dispatchEvent(new Event('error'))
    await expect(promise).resolves.toBeUndefined()
  })
})
