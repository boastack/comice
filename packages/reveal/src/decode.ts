/**
 * @comice/reveal/decode
 * ─────────────────────────────────────────────────────────────────────────────
 * "Never reveal a blank frame" — waitForDecode's actual mechanism. Resolves
 * once the target's real image/video data is ready to paint, using the
 * browser's own decode signal rather than a guessed delay (the whole point
 * of the state-machine-not-timeline design: no setTimeout standing in for
 * "probably loaded by now").
 */

/** True once `el` is known-ready to paint without a blank/placeholder frame. */
function isAlreadyReady(el: HTMLImageElement | HTMLVideoElement): boolean {
  if (el instanceof HTMLImageElement) {
    return el.complete && el.naturalWidth > 0
  }
  // The numeric readyState constant, not HTMLMediaElement.HAVE_CURRENT_DATA
  // — some DOM implementations (happy-dom, at time of writing) expose the
  // HTMLMediaElement constructor without its static readyState constants,
  // which would make this comparison silently always false rather than
  // throwing, so it's worth pinning the literal value instead of trusting
  // the constant exists. Per the spec this value is stable: HAVE_NOTHING=0,
  // HAVE_METADATA=1, HAVE_CURRENT_DATA=2, HAVE_FUTURE_DATA=3, HAVE_ENOUGH_DATA=4.
  const HAVE_CURRENT_DATA = 2
  return el.readyState >= HAVE_CURRENT_DATA
}

/**
 * Resolves once `target` is ready to paint, or immediately if it already
 * is, or immediately if `target` isn't an <img>/<video> at all (a plain
 * element has nothing to decode — waitForDecode is a no-op for it, not an
 * error). Uses HTMLImageElement.decode() where available (the real
 * decode-complete signal, not just "the bytes are in") and falls back to
 * the loadeddata event for <video>, since HTMLVideoElement has no
 * decode() method.
 */
export async function waitForMediaReady(target: Element): Promise<void> {
  if (target instanceof HTMLImageElement) {
    if (isAlreadyReady(target)) return
    if (typeof target.decode === 'function') {
      try {
        await target.decode()
        return
      } catch {
        // decode() rejects if the image errors or is removed mid-decode —
        // fall through to the load/error event path below rather than
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

  if (target instanceof HTMLVideoElement) {
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
    return
  }

  // Not media — nothing to decode, resolve immediately.
}
