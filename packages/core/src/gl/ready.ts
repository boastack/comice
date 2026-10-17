/**
 * comice/core/gl/ready
 * ─────────────────────────────────────────────────────────────────────────────
 * "Never upload a blank/garbage frame" — the same mechanism
 * packages/reveal/src/decode.ts uses for "never reveal a blank frame",
 * ported here rather than imported: core cannot depend on @comice/reveal
 * (that would invert the actual dependency direction — reveal depends on
 * core, never the reverse, per the "no plugin imports another plugin, core
 * imports no plugin" rule in ROADMAP.md), and reveal cannot depend on core's
 * internal gl/ path either, since gl/ isn't part of core's public surface.
 * If this drifts from reveal's copy, that's a sign the two should be
 * unified behind one published entry point — not yet worth the churn for
 * one small function used identically in both places.
 */

/** True once `el` is known-ready to upload without a blank/placeholder frame. */
function isAlreadyReady(el: HTMLImageElement | HTMLVideoElement): boolean {
  if (el instanceof HTMLImageElement) {
    return el.complete && el.naturalWidth > 0
  }
  // See packages/reveal/src/decode.ts's identical comment: pinned as a
  // literal because some DOM implementations (happy-dom, at time of
  // writing) expose HTMLMediaElement without its static readyState
  // constants, which would make `el.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA`
  // silently always false rather than throwing.
  const HAVE_CURRENT_DATA = 2
  return el.readyState >= HAVE_CURRENT_DATA
}

/**
 * Resolves once `target` is ready to upload, or immediately if it already
 * is. Uses HTMLImageElement.decode() where available and falls back to the
 * loadeddata event for <video>, matching reveal's waitForMediaReady exactly.
 */
export function waitForMediaReady(target: HTMLImageElement | HTMLVideoElement, signal?: AbortSignal): Promise<void> {
  if (isAlreadyReady(target) || signal?.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const event = target instanceof HTMLImageElement ? 'load' : 'loadeddata'
    const settle = () => {
      target.removeEventListener(event, settle)
      target.removeEventListener('error', settle)
      signal?.removeEventListener('abort', settle)
      resolve()
    }
    target.addEventListener(event, settle, { once: true })
    target.addEventListener('error', settle, { once: true })
    signal?.addEventListener('abort', settle, { once: true })
    if (target instanceof HTMLImageElement && typeof target.decode === 'function') {
      // Install listeners before decoding: an error can arrive while decode rejects.
      target.decode().then(settle, () => {
        if (target.complete && target.currentSrc) settle()
      })
    }
  })
}
