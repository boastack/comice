/**
 * test/aura-downsample.test — packages/aura/src/downsample.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs against happy-dom plus test/fake-webgl2.ts, including its new
 * readPixels fake (added this pass alongside particles' instanced-draw
 * fakes).
 */

import { beforeEach, describe, expect, it } from 'bun:test'
import { createDownsampler } from '../packages/aura/src/downsample.js'
import { createFakeGL2 } from './fake-webgl2.js'

function fakeTexture(id: string): WebGLTexture {
  return { __id: id } as unknown as WebGLTexture
}

describe('createDownsampler', () => {
  it('sample() returns a 32x32 pixel buffer for a real texture', () => {
    const gl = createFakeGL2()
    const downsampler = createDownsampler(gl)
    const result = downsampler.sample(fakeTexture('media'))
    expect(result).not.toBeNull()
    expect(result!.width).toBe(32)
    expect(result!.height).toBe(32)
    expect(result!.pixels.length).toBe(32 * 32 * 4)
  })

  it('sample() does not throw across repeated calls (reuses its own framebuffer/texture)', () => {
    const gl = createFakeGL2()
    const downsampler = createDownsampler(gl)
    expect(() => {
      downsampler.sample(fakeTexture('a'))
      downsampler.sample(fakeTexture('b'))
      downsampler.sample(fakeTexture('c'))
    }).not.toThrow()
  })

  it('sample() returns null, never throws, when the downsample program fails to compile', () => {
    const gl = createFakeGL2({ failShaderCompile: true })
    const downsampler = createDownsampler(gl)
    expect(downsampler.sample(fakeTexture('media'))).toBeNull()
  })

  it('sample() returns null when texture/framebuffer creation fails at construction', () => {
    const gl = createFakeGL2({ failCreateTexture: true })
    const downsampler = createDownsampler(gl)
    expect(downsampler.sample(fakeTexture('media'))).toBeNull()
  })

  it('sample() returns null when the downsample program fails to link', () => {
    const gl = createFakeGL2({ failProgramLink: true })
    const downsampler = createDownsampler(gl)
    expect(downsampler.sample(fakeTexture('media'))).toBeNull()
  })

  it('sample() returns null when createProgram() itself returns null', () => {
    const gl = createFakeGL2({ failCreateProgram: true })
    const downsampler = createDownsampler(gl)
    expect(downsampler.sample(fakeTexture('media'))).toBeNull()
  })

  it('sample() returns null after destroy()', () => {
    const gl = createFakeGL2()
    const downsampler = createDownsampler(gl)
    downsampler.destroy()
    expect(downsampler.sample(fakeTexture('media'))).toBeNull()
  })

  it('destroy() is idempotent (does not throw when called twice)', () => {
    const gl = createFakeGL2()
    const downsampler = createDownsampler(gl)
    downsampler.destroy()
    expect(() => downsampler.destroy()).not.toThrow()
  })

  it('a second createDownsampler() against the same gl compiles independently without throwing', () => {
    const gl = createFakeGL2()
    const a = createDownsampler(gl)
    const b = createDownsampler(gl)
    expect(a.sample(fakeTexture('x'))).not.toBeNull()
    expect(b.sample(fakeTexture('y'))).not.toBeNull()
  })
})
