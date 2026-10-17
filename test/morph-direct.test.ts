import { describe, expect, it } from 'bun:test'
import { comice } from 'comice'
import { morph } from '../packages/morph/src/index.js'
import { getSharedScheduler } from 'comice/scheduler'
import { createFakeGL2, installFake2DContext } from './fake-webgl2.js'
import { installFakeIntersectionObserver } from './fake-intersection.js'
import { examples } from '../demo/morph/examples.js'

describe('direct endpoint morphs', () => {
  it('rejects the removed intermediate-shape option rather than silently ignoring it', () => {
    for (const via of ['circle(40%)', { shape: 'circle(40%)', grow: .3 }]) {
      expect(() => morph({ from: 'inset(0)', to: 'ellipse(40% 30%)', via } as never)).toThrow(/Unsupported morph option: via/)
    }
  })

  it('all demo configurations use endpoint geometry without an intermediate stage', () => {
    expect(examples).toHaveLength(24)
    for (const demo of examples) {
      expect(demo.options).not.toHaveProperty('via')
      expect(() => morph({ ...demo.options, ...(demo.mask ? { to: demo.mask } : {}) })).not.toThrow()
    }
  })

  it('bakes only two endpoint fields and preserves forward and reverse progress', async () => {
    const raster = installFake2DContext(), original = HTMLCanvasElement.prototype.getContext
    const observer = installFakeIntersectionObserver(), gl = createFakeGL2()
    HTMLCanvasElement.prototype.getContext = function(type: string, ...args: unknown[]) {
      return type === 'webgl2' ? gl : original.call(this, type as never, ...args as never[])
    } as typeof original
    try {
      for (const direction of ['forward', 'reverse'] as const) {
        const image = document.createElement('img')
        Object.defineProperties(image, { complete: { value: true }, naturalWidth: { value: 40 }, naturalHeight: { value: 20 } })
        Object.defineProperty(image, 'getBoundingClientRect', { value: () => ({ left: 0, top: 0, width: 40, height: 20, right: 40, bottom: 20 }) })
        document.body.append(image)
        const effect = morph({ from: 'inset(0)', to: 'ellipse(40% 30%)', direction, join: true })
        const before = raster.callLog.filledPaths
        const handle = comice(image).use(effect)
        try {
          handle.set(effect, { progress: .37 })
          for (let i = 0; i < 14; i++) await Promise.resolve()
          expect(effect.params!.getParam('progress')).toBe(.37)
          expect(raster.callLog.filledPaths - before).toBe(2)
          expect(document.querySelector('canvas')).not.toBeNull()
          expect(image.style.visibility).toBe('hidden')
        } finally { handle.destroy(); image.remove() }
        expect(document.querySelector('canvas')).toBeNull()
      }
    } finally {
      observer.uninstall(); getSharedScheduler().stop()
      HTMLCanvasElement.prototype.getContext = original; raster.uninstall()
    }
  })
})
