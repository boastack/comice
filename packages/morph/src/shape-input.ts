import { compileClipPath, type ClipPathShape, type ShapeMask } from './clip-path.js'
import type { RasterizedMaskSource } from 'comice/gl'

/** A complete SVG preserves groups, transforms, compound paths and holes.
 * Strings accept an SVG URL/document or CSS clip-path; path data uses core's shape object. */
export type MorphShape = ClipPathShape | string | SVGSVGElement | HTMLImageElement | RasterizedMaskSource
export type ResolvedShape = { mask: ShapeMask; release(): void }

export function validateShape(shape: MorphShape): void {
  if (typeof shape === 'string') {
    if (!shape.trim()) throw new Error('[comice] A morph shape cannot be empty.')
    if (/^[a-z-]+\(/i.test(shape.trim())) compileClipPath(shape)
    return
  }
  if (shape && typeof shape === 'object' && 'clipPath' in shape) { compileClipPath(shape.clipPath); return }
  if (shape instanceof Element && (shape.tagName.toLowerCase() === 'svg' || shape instanceof HTMLImageElement)) return
  if (shape && typeof shape === 'object' && 'type' in shape && ['shape', 'text', 'image'].includes(shape.type)) {
    if (shape.type === 'text') {
      if (typeof shape.text !== 'string' || !shape.text.trim()) throw new Error('[comice] A morph text mask needs non-empty text.')
      if (shape.font !== undefined && (typeof shape.font !== 'string' || !shape.font.trim())) throw new Error('[comice] A morph text font must be a CSS font string.')
    }
    return
  }
  throw new Error('[comice] A morph shape must be an SVG URL/document/element, CSS clip-path, decoded image, or mask source.')
}

export async function resolveShape(shape: MorphShape, signal: AbortSignal, doc: Document = document): Promise<ResolvedShape> {
  validateShape(shape)
  if (signal.aborted) throw new DOMException('Shape load aborted.', 'AbortError')
  if (typeof shape === 'object' && 'type' in shape) {
    if (shape.type === 'text' && shape.font && doc.fonts?.load) {
      // Load the actual font before measuring or baking either endpoint. Waiting
      // for fonts.ready alone does not start a face unused by any DOM text.
      const loaded = doc.fonts.load(shape.font, shape.text)
      await new Promise<void>((resolve, reject) => {
        const abort = () => { signal.removeEventListener('abort', abort); reject(new DOMException('Shape load aborted.', 'AbortError')) }
        signal.addEventListener('abort', abort, { once: true })
        loaded.then(() => { signal.removeEventListener('abort', abort); resolve() }, error => { signal.removeEventListener('abort', abort); reject(error) })
        if (signal.aborted) abort()
      })
      if (signal.aborted) throw new DOMException('Shape load aborted.', 'AbortError')
    }
    if (shape.type !== 'image') return { mask: shape, release() {} }
    shape = shape.source
  }
  if (typeof shape === 'object' && 'clipPath' in shape) return { mask: compileClipPath(shape.clipPath), release() {} }
  if (typeof shape === 'string' && /^[a-z-]+\(/i.test(shape.trim())) return { mask: compileClipPath(shape), release() {} }
  let objectUrl: string | null = null
  const release = () => { if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null } }
  let image: HTMLImageElement
  const ownsImage = !(shape instanceof HTMLImageElement)
  if (shape instanceof HTMLImageElement) image = shape
  else {
    let svg = typeof shape === 'string' ? shape.trim() : new XMLSerializer().serializeToString(shape)
    if (svg.startsWith('<')) {
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
      if (doc.querySelector('parsererror') || doc.documentElement.localName !== 'svg') throw new Error('[comice] Invalid SVG document.')
      if (!doc.documentElement.hasAttribute('xmlns')) doc.documentElement.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
      svg = new XMLSerializer().serializeToString(doc.documentElement)
      objectUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
    }
    image = new Image()
    image.crossOrigin = 'anonymous'
    image.src = objectUrl ?? svg
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { image.removeEventListener('load', ready); image.removeEventListener('error', fail); signal.removeEventListener('abort', abort) }
      const ready = () => { cleanup(); resolve() }
      const fail = () => { cleanup(); reject(new Error(`[comice] Could not load morph shape: ${typeof shape === 'string' && !shape.startsWith('<') ? shape : 'SVG/image'}`)) }
      const abort = () => { cleanup(); if (ownsImage) image.removeAttribute('src'); reject(new DOMException('Shape load aborted.', 'AbortError')) }
      image.addEventListener('load', ready, { once: true }); image.addEventListener('error', fail, { once: true }); signal.addEventListener('abort', abort, { once: true })
      if (image.complete) queueMicrotask(() => image.naturalWidth > 0 ? ready() : fail())
    })
    if (signal.aborted) throw new DOMException('Shape load aborted.', 'AbortError')
    return { mask: { type: 'image', source: image }, release }
  } catch (error) { release(); throw error }
}
