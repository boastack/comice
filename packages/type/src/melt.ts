/**
 * @comice/type/melt
 * ─────────────────────────────────────────────────────────────────────────────
 * melt on a real element. The developer only changes the text —
 * `el.textContent = next` (a rail's onActive, a timer, anything) — and the
 * element melts from the old word into the new one. The text stays real
 * DOM throughout: the new content is in place (and selectable, indexable)
 * from the moment it's set.
 *
 * HOW: for the length of the melt, the element's own content is hidden
 * (`visibility: hidden`, which keeps its layout) and two ghosts — the old
 * text and the new — cross-fade over it, each with its own blur (gooey.ts).
 * The element itself carries the SVG alpha-threshold filter that welds
 * them. The ghosts are its ::before/::after, not child nodes, so its DOM
 * is never touched: textContent mid-melt is exactly the new text (child
 * ghosts read "BasaltAuroraBasalt"), and the alt text `/ ""` keeps them out
 * of the accessibility tree. The cost: a ghost is plain text, so inline
 * markup shows unstyled for the length of a melt. When the melt ends,
 * every attribute and style touched is restored.
 *
 * Driven progress (a driver, `.set()`, `.map()`) scrubs the last pair of
 * words instead: 0 shows the old one, 1 the new.
 */

import { prefersReducedMotion } from 'comice'
import { getSharedScheduler } from 'comice/scheduler'
import { ease, meltFrame, thresholdMatrix, wordFilter, type MeltOptions } from './gooey.js'

const SVG = 'http://www.w3.org/2000/svg'
let filterCount = 0

const GHOST_CSS = ['before', 'after']
  .map((pseudo, i) => {
    const which = i === 0 ? 'from' : 'to'
    return `[data-comice-melt]::${pseudo} {
  content: attr(data-comice-melt-${which});
  content: attr(data-comice-melt-${which}) / "";
  position: absolute; inset: 0; margin: 0; padding: inherit; box-sizing: border-box;
  visibility: visible; pointer-events: none; user-select: none;
  opacity: var(--comice-melt-${which}-opacity); filter: var(--comice-melt-${which}-filter);
}`
  })
  .join('\n')

/** The ghost rules, once per document: a constructable sheet where there
 *  is one (allowed under a strict CSP), a <style> otherwise. */
const styled = new WeakSet<Document>()
function ensureGhostStyles(doc: Document): void {
  if (styled.has(doc)) return
  styled.add(doc)
  const view = doc.defaultView as (Window & { CSSStyleSheet?: typeof CSSStyleSheet }) | null
  if (view?.CSSStyleSheet && 'adoptedStyleSheets' in doc && 'replaceSync' in view.CSSStyleSheet.prototype) {
    const sheet = new view.CSSStyleSheet()
    sheet.replaceSync(GHOST_CSS)
    doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet]
    return
  }
  const style = doc.createElement('style')
  style.textContent = GHOST_CSS
  doc.head.appendChild(style)
}

export type Melt = {
  /** Shows the last pair at `progress` (0 old .. 1 new); 1 ends the melt. */
  scrub(progress: number): void
  destroy(): void
}

export function createMelt(target: HTMLElement, options: MeltOptions = {}): Melt {
  const { hold = true, duration = 600 } = options
  const doc = target.ownerDocument

  // The alpha threshold, as an SVG filter the element references by id.
  const filterId = `comice-melt-${++filterCount}`
  const svg = doc.createElementNS(SVG, 'svg')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('width', '0')
  svg.setAttribute('height', '0')
  svg.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden')
  const filter = doc.createElementNS(SVG, 'filter')
  filter.setAttribute('id', filterId)
  // Blurred words spill well past the element's box; don't clip them.
  filter.setAttribute('x', '-50%')
  filter.setAttribute('y', '-100%')
  filter.setAttribute('width', '200%')
  filter.setAttribute('height', '300%')
  const matrix = doc.createElementNS(SVG, 'feColorMatrix')
  matrix.setAttribute('in', 'SourceGraphic')
  matrix.setAttribute('type', 'matrix')
  matrix.setAttribute('values', thresholdMatrix(options.threshold))
  filter.appendChild(matrix)
  svg.appendChild(filter)
  doc.body.appendChild(svg)

  ensureGhostStyles(doc)
  let saved: { visibility: string; filter: string; position: string } | null = null
  // The content as it last settled (markup included, to tell changes
  // apart), and the pair of texts being melted between.
  let shown = target.innerHTML
  let pair: { from: string; to: string } | null = null
  let shownText = target.textContent ?? ''
  let unregister: (() => void) | null = null

  const GHOST_PROPS = ['from-opacity', 'from-filter', 'to-opacity', 'to-filter'].map((p) => `--comice-melt-${p}`)

  function showGhosts(): void {
    if (saved || !pair) return
    saved = { visibility: target.style.visibility, filter: target.style.filter, position: target.style.position }
    if (getComputedStyle(target).position === 'static') target.style.position = 'relative'
    target.setAttribute('data-comice-melt', '')
    target.setAttribute('data-comice-melt-from', pair.from)
    target.setAttribute('data-comice-melt-to', pair.to)
    target.style.visibility = 'hidden'
    target.style.filter = `url(#${filterId})`
  }

  function hideGhosts(): void {
    if (!saved) return
    ;['data-comice-melt', 'data-comice-melt-from', 'data-comice-melt-to'].forEach((a) => target.removeAttribute(a))
    GHOST_PROPS.forEach((p) => target.style.removeProperty(p))
    target.style.visibility = saved.visibility
    target.style.filter = saved.filter
    target.style.position = saved.position
    saved = null
  }

  function render(progress: number): void {
    if (progress >= 1 || !pair) return hideGhosts()
    showGhosts()
    const frame = meltFrame(ease(options.curve, progress), options)
    const values = [`${frame.from.opacity}`, wordFilter(frame.from), `${frame.to.opacity}`, wordFilter(frame.to)]
    GHOST_PROPS.forEach((p, i) => target.style.setProperty(p, values[i]!))
  }

  function stop(): void {
    unregister?.()
    unregister = null
  }

  function onChange(): void {
    const now = target.innerHTML
    if (hold && now === shown) return
    stop()
    hideGhosts()
    const text = target.textContent ?? ''
    pair = { from: shownText, to: text }
    shown = now
    shownText = text
    // Reduced motion: the new text simply replaces the old.
    if (prefersReducedMotion()) return
    let start: number | null = null
    render(0)
    unregister = getSharedScheduler().add(
      (deltaMs, timestamp) => {
        // Timed from the change, not from the shared loop's last frame: on
        // a slow page a whole frame's delta (225ms, seen) would otherwise
        // land on the first tick, most of it from before the text changed.
        start ??= timestamp - Math.min(deltaMs, 16.67)
        const elapsed = timestamp - start
        render(elapsed / duration)
        if (elapsed >= duration) stop()
      },
      () => unregister !== null && target.isConnected,
    )
  }

  const observer = new MutationObserver(() => onChange())
  observer.observe(target, { childList: true, characterData: true, subtree: true })

  return {
    scrub(progress) {
      stop()
      render(progress)
    },
    destroy() {
      stop()
      hideGhosts()
      observer.disconnect()
      svg.remove()
    },
  }
}
