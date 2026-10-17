import { describe, expect, it } from 'bun:test'
import { compileClipPath, radiusPair } from '../packages/morph/src/clip-path.js'
import { resolveShape } from '../packages/morph/src/shape-input.js'
import { morph } from '../packages/morph/src/index.js'

const shape = (value: string, w = 400, h = 200) => compileClipPath(value)(w, h) as Extract<import('comice/gl').RasterizedMaskSource, { type: 'shape' }>
describe('caller CSS geometry', () => {
  it('preserves computed calc radii and uses a real native SVG grammar when available', () => {
    expect(radiusPair('calc(10% + 4px) 20%')).toEqual(['calc(10% + 4px)', '20%'])
    expect(radiusPair('')).toEqual(['0px', '0px'])
    expect(() => radiusPair('10px 20px 30px')).toThrow(/radius/)
    const old = Object.getOwnPropertyDescriptor(globalThis, 'CSS')
    Object.defineProperty(globalThis, 'CSS', { configurable: true, value: { supports: (_property: string, value: string) => !value.includes('X') && !value.includes('bad') } })
    try {
      expect(shape(`path('M0 0A10 10 0 0110 10Z')`).path).toContain('0110')
      expect(() => shape(`path('M0 0Lbad')`)).toThrow()
      Object.defineProperty(globalThis, 'CSS', { configurable: true, value: { supports: (_property: string, value: string) => !value.includes('X') && !value.includes('99') } })
      expect(() => shape(`path('M0 0L99 99')`)).toThrow(/path/)
    } finally { if (old) Object.defineProperty(globalThis, 'CSS', old); else delete (globalThis as { CSS?: unknown }).CSS }
  })
  it('recomputes percent coordinates on resize while retaining pixel coordinates', () => {
    const input = compileClipPath('polygon(50% 0%, 12px 100%, 100% 100%)')
    expect(input(400, 200)).toMatchObject({ path: 'M200 0L12 200L400 200Z', fit: 'stretch', viewBox: [0,0,400,200], fillRule: 'nonzero' })
    expect(input(800, 100)).toMatchObject({ path: 'M400 0L12 100L800 100Z', viewBox: [0,0,800,100] })
    expect(shape('polygon(evenodd, 0% 0%, 100% 0%, 50% 100%)').fillRule).toBe('evenodd')
    expect(shape('polygon(nonzero, 0% 0%, 100% 0%, 50% 100%) border-box').fillRule).toBe('nonzero')
  })
  it('retains CSS path scale and fill-rule rather than fitting path bounds', () => {
    const d = 'M10 10H390V190H10Z M140 60H260V140H140Z'
    expect(shape(`path(evenodd, '${d}')`, 800, 600)).toMatchObject({ path: d, fillRule: 'evenodd', viewBox: [0,0,800,600], fit: 'stretch' })
    expect(shape(`path("M0 0C10 40 20 40 30 0Z")`).fillRule).toBe('nonzero')
    expect(shape(`path(nonzero, 'M0 0L10 10Z')`).fillRule).toBe('nonzero')
    expect(shape(`path('M0 0A10 10 0 0 1 10 10Z')`).path).toContain('A10')
    expect(shape('xywh(10px 20px 100px 120px)').path).toContain('M10 20')
  })
  it('uses CSS circle diagonal percentages, positions and ellipse axis percentages', () => {
    expect(shape('circle(10% at center)').path).toContain(`A${Math.hypot(400,200)/Math.SQRT2*10/100}`)
    expect(shape('circle(at top)').path).toBe('M0 0Z')
    expect(shape('circle(20px at bottom right)').path).toContain('M380 200')
    expect(shape('circle(20px at left)').path).toContain('M-20 100')
    expect(shape('ellipse(40% 25% at right center)').path).toContain('M240 100A160 50')
    expect(shape('ellipse()').path).toContain('A200 100')
    expect(shape('ellipse(farthest-side closest-side at 70% 40%)').path).toContain('A280 80')
    expect(shape('circle(farthest-side at left top)').path).toContain('A400 400')
    expect(shape('circle()').path).toContain('A100 100')
  })
  it('expands inset shorthand, resizes overspecified sides and clamps overlapping corners', () => {
    expect(shape('inset(10px)').path).toBe('M10 10L390 10L390 10L390 190L390 190L10 190L10 190L10 10L10 10Z')
    for (const clip of ['inset(10px 20px)', 'inset(10px 20px 30px)', 'inset(10px 20px 30px 40px)', 'inset(70% 80% 70% 80%)', 'inset(0 round 80%)', 'inset(0 round 10px 20px 30px 40px / 10px 20px)', 'rect(auto auto auto auto)', 'rect(10px 390px 190px 10px round 20px)', 'xywh(10% 20px 70% 80% round 20px)', 'inset(calc(10% + 12px) calc(100% - 20px))']) expect(shape(clip).path).toMatch(/^M/)
  })
  it('accepts strings and explicit clip objects, without asynchronous image loading', async () => {
    const signal = new AbortController().signal
    for (const value of ['inset(0)', {clipPath:'circle(40%)'}]) {
      const result = await resolveShape(value, signal)
      expect(typeof result.mask).toBe('function'); result.release()
    }
    expect(() => morph({to:'circle(40%)',join:true})).not.toThrow()
    for (const key of ['operation','layout','thread','stagger','order','maskSize','into']) expect(() => morph({to:'circle(40%)',[key]:true} as never)).toThrow(/Unsupported/)
    expect(() => morph({})).not.toThrow() // both ends omitted: the media's own frame
    expect(() => morph(undefined as never)).toThrow(/options object/)
    expect(() => morph('circle(40%)' as never)).toThrow(/options object/)
    for (const liquid of [-1,2,NaN]) expect(() => morph({to:'circle(40%)',liquid})).toThrow(/Liquid/)
    for (const liquidSheen of [-1,NaN]) expect(() => morph({to:'circle(40%)',liquidSheen})).toThrow(/sheen/)
    expect(() => morph({to:'circle(40%)',direction:'wrong' as never})).toThrow(/direction/)
    expect(() => morph({to:'circle(40%)',maskRasterization:{sdf:false}})).toThrow(/distance/)
  })
  it('rejects unsupported CSS and malformed dimensions before mounting', () => {
    const invalid = ['none', 'url(#shape)', 'shape(from 0 0)', 'circle(2em)', 'circle(calc(10px 20px))', 'polygon(0% 0%,, 50% 100%, 100% 0%)', 'polygon(0% 0%, 50% 100%, 100% 0%,)', 'path("M0 0L10")', 'path("M0 0L1e999 2")', 'path("M0 0Z10")', 'path("M0 0L5 5e")', 'path("M0 0A-1 2 0 0 0 4 5")', 'path("M0 0A1 2 0 3 0 4 5")', 'path("M0 0Z L0 0A1 2 0 0 1 4 5",)' , 'circle(-4px)', 'ellipse(20%)', 'ellipse(-10px 20px)', 'circle(10px 20px)', 'circle(10px at left top 20px)', 'circle(10px at center at center)', 'inset()', 'inset(1px 2px 3px 4px 5px)', 'inset(0 round -10px)', 'inset(0 round 10px / 10px / 10px)', 'inset(0 round 10px round 10px)', 'rect(0 0)', 'xywh(0 0 -1px 10px)', 'polygon(0% 0%, 100% 0%)', 'polygon(0% 0%, 100% 0%, 10% 20% 30%)', 'polygon(0% 0%, 100% 0%, bogus)', 'path(bogus, "M0 0Z")', 'path("M0 0Z", "M0 0Z", "M0 0Z")', 'path(M0 0Z)', 'path("X0 0Z")', 'path("M0 0X5 5")', 'circle(calc(1px * 2))', 'circle(calc())', 'circle(20)', 'polygon(0% 0%, 100% 0%, calc(1px 20% 100%)', 'polygon(0% 0%, 100% 0%, 20% 100%))', 'path("M0 0Z)', 'circle(20px) content-box']
    for (const value of invalid) expect(() => compileClipPath(value)).toThrow(/clip-path/)
  })
})

describe('full-frame distance fields', () => {
  it('counts the raster boundary as outside for sheen and refraction on filled frames', async () => {
    const { createRasterizedMask } = await import('../packages/core/src/gl/mask.js')
    const { createFakeGLContext, installFake2DContext } = await import('./fake-webgl2.js')
    const raster = installFake2DContext(), context = createFakeGLContext(document.createElement('canvas'))
    let values: Float32Array | undefined
    context.gl.texImage2D = ((...args:unknown[]) => { if (args[8] instanceof Float32Array) values=args[8] }) as typeof context.gl.texImage2D
    const mask = createRasterizedMask(context)
    try {
      mask.rasterize({type:'shape',path:'M0 0H8V6H0Z',viewBox:[0,0,8,6],fit:'stretch'},8,6,{sdf:true,precision:'half',bounded:true,resolution:[8,6],maxDistance:8})
      expect(values![0]).toBe(-1)
      expect(values![2*8+3]).toBe(-3)
      expect(values![5*8+7]).toBe(-1)
    } finally { mask.destroy(); raster.uninstall() }
  })
})
