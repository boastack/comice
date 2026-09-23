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
export async function waitForMediaReady(target: HTMLImageElement | HTMLVideoElement): Promise<void> {
  if (target instanceof HTMLImageElement) {
    if (isAlreadyReady(target)) return
    if (typeof target.decode === 'function') {
      try {
        await target.decode()
        return
      } catch {
        // Falls through to the load/error event path below rather than
        // leaving the caller waiting forever.
      }
    }
    await new Promise<void>((resolve) => {
      const onSettle = () => {
        target.removeEventListener('load', onSettle)
        target.removeEventListener('error', onSettle)
        resolve()
      }
      target.addEventListener('load', onSettle, { once: true })
      target.addEventListener('error', onSettle, { once: true })
    })
    return
  }

  // HTMLVideoElement
  if (isAlreadyReady(target)) return
  await new Promise<void>((resolve) => {
    const onSettle = () => {
      target.removeEventListener('loadeddata', onSettle)
      target.removeEventListener('error', onSettle)
      resolve()
    }
    target.addEventListener('loadeddata', onSettle, { once: true })
    target.addEventListener('error', onSettle, { once: true })
  })
}
