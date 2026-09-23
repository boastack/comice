/**
 * test/gl-ready.test — packages/core/src/gl/ready.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Mirrors test/reveal-decode.test.ts exactly — this is the same mechanism,
 * ported rather than shared (see ready.ts's file header for why), so it
 * gets the same test treatment as its reveal counterpart, independent of
 * plane.ts which is the only other thing that calls it in this package.
 */

import { describe, expect, it } from 'bun:test'
import { waitForMediaReady } from '../packages/core/src/gl/ready.js'

describe('waitForMediaReady (gl) — images', () => {
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

describe('waitForMediaReady (gl) — video', () => {
  it('resolves immediately when readyState already indicates current data', async () => {
    const video = document.createElement('video')
    Object.defineProperty(video, 'readyState', { value: 2, configurable: true })
    await expect(waitForMediaReady(video)).resolves.toBeUndefined()
  })

  it('waits for the loadeddata event when readyState is not ready yet', async () => {
    const video = document.createElement('video')
    Object.defineProperty(video, 'readyState', { value: 0, configurable: true })
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
