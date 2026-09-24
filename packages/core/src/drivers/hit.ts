/**
 * comice/core/drivers/hit
 * ─────────────────────────────────────────────────────────────────────────────
 * Internal (not exported from drivers/index.ts): where the event-driven
 * drivers listen, and how they decide an event is "for" their target.
 *
 * WHY NOT target.addEventListener: every GL plugin (distort, color, mosaic,
 * ascii, morph, dissolve) hides its target with `visibility: hidden` and
 * draws into a sibling canvas with `pointer-events: none`. A hidden element
 * is skipped by hit-testing, so it never receives a single pointer or click
 * event — `comice(img).use(distort()).driver(pointer())`, distort's own spec
 * example, got zero input in a real browser. Found on harness/site/ with
 * Playwright; happy-dom does no hit-testing (it dispatches straight at the
 * target), so every driver unit test passed regardless.
 *
 * So drivers listen on the target's DOCUMENT, in the capture phase (it runs
 * before any page handler can stopPropagation, and non-bubbling events like
 * pointerleave still pass through the document on the way down), and
 * decide per event.
 */

/** Adds a capture-phase listener on the target's document; returns the remover. */
export function listenOnDocument<K extends keyof DocumentEventMap>(
  target: Element,
  type: K,
  handler: (event: DocumentEventMap[K]) => void,
): () => void {
  const doc = target.ownerDocument
  const listener = handler as EventListener
  doc.addEventListener(type, listener, { capture: true, passive: true })
  return () => doc.removeEventListener(type, listener, { capture: true })
}

/** Whether (clientX, clientY) lies inside the target's layout box. Uses
 *  getBoundingClientRect(), which `visibility: hidden` does not affect. */
export function pointInTarget(target: Element, clientX: number, clientY: number): boolean {
  const rect = target.getBoundingClientRect()
  return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom
}

/**
 * Whether a pointer/mouse event "reaches" the target:
 *
 *  - its path includes the target (the normal, visible-target case, and
 *    any event dispatched at the target directly), or
 *  - it landed inside the target's box on an element that CONTAINS the
 *    target — i.e. it fell through a hidden target to one of its ancestors.
 *
 * The second rule deliberately excludes overlays: a caption or button drawn
 * over the image does not contain it, so clicking that overlay does not also
 * click the image's driver — the same thing native hit-testing would do if
 * the image were visible.
 */
export function eventReachesTarget(target: Element, event: MouseEvent): boolean {
  if (event.composedPath().includes(target)) return true
  const landedOn = event.target
  if (!(landedOn instanceof Node) || !landedOn.contains(target)) return false
  return pointInTarget(target, event.clientX, event.clientY)
}

/** Whether a pointerleave event means the pointer left the whole window. */
export function isWindowLeave(target: Element, event: Event): boolean {
  return event.target === target.ownerDocument.documentElement
}
