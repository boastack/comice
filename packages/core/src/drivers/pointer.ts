/**
 * comice/core/drivers/pointer
 * ─────────────────────────────────────────────────────────────────────────────
 * Section 04: { radius, lag }. Raw pointer position and velocity, normalised
 * against the element's bounds.
 *
 * Unlike hover, this driver never leaves the 'idle' <-> 'entering' binary —
 * it reports continuous position and velocity every frame the pointer is
 * within `radius` of the element, for plugins that read a field (distort's
 * bulge/lens/ripple, spotlight's cursor-follow) rather than a discrete
 * enter/leave. `progress` mirrors hover's contract (0 outside, 1 inside) so
 * a plugin written against progress alone still works unmodified; the
 * `pointer` and `velocity` fields are what field-based plugins actually
 * want.
 */

import type { Driver, DriverSignal } from '../types.js'

export type PointerOptions = {
  /** Influence radius in px. Signal only reports progress: 1 within this distance of the element's bounds. Default 160. */
  radius?: number
  /** Follow smoothing, 0..1. 0 is instant, closer to 1 lags further behind the raw pointer. Default 0.12. */
  lag?: number
}

export function pointer(options: PointerOptions = {}): Driver {
  const { radius = 160, lag = 0.12 } = options

  return {
    name: 'pointer',
    attach(target, onSignal) {
      let rafId: number | null = null
      let lastX = 0
      let lastY = 0
      let smoothX = 0
      let smoothY = 0
      let lastTimestamp = 0
      let inside = false
      let havePosition = false

      function withinRadius(x: number, y: number, rect: DOMRect): boolean {
        if (radius <= 0) return x >= 0 && x <= rect.width && y >= 0 && y <= rect.height
        const clampedX = Math.max(0, Math.min(rect.width, x))
        const clampedY = Math.max(0, Math.min(rect.height, y))
        const dx = x - clampedX
        const dy = y - clampedY
        return dx * dx + dy * dy <= radius * radius
      }

      function onMove(event: PointerEvent): void {
        const rect = target.getBoundingClientRect()
        const x = event.clientX - rect.left
        const y = event.clientY - rect.top

        inside = withinRadius(x, y, rect)
        if (!inside) return

        if (!havePosition) {
          // First sample inside range: snap smoothing to the raw position
          // rather than lerping in from (0, 0).
          smoothX = x
          smoothY = y
          havePosition = true
        }
        lastX = x
        lastY = y
      }

      function onLeaveWindow(): void {
        inside = false
      }

      function tick(timestamp: number): void {
        const deltaMs = lastTimestamp ? timestamp - lastTimestamp : 16.67
        lastTimestamp = timestamp

        if (inside && havePosition) {
          const prevX = smoothX
          const prevY = smoothY
          // Frame-rate-independent lerp: lag is defined per-frame-at-60fps,
          // scaled by actual elapsed time so a dropped frame doesn't cause
          // a visible jump.
          const t = 1 - Math.pow(lag, deltaMs / 16.67)
          smoothX += (lastX - smoothX) * t
          smoothY += (lastY - smoothY) * t

          const velocityX = deltaMs > 0 ? ((smoothX - prevX) / deltaMs) * 1000 : 0
          const velocityY = deltaMs > 0 ? ((smoothY - prevY) / deltaMs) * 1000 : 0
          const velocity = Math.sqrt(velocityX * velocityX + velocityY * velocityY)

          onSignal({
            progress: 1,
            pointer: { x: smoothX, y: smoothY },
            velocity,
          })
        } else if (havePosition) {
          // Pointer left range: report the exit once, then stop reporting
          // position until it re-enters. Keeps the last known point rather
          // than snapping to (0, 0) so a leaving plugin can ease from
          // wherever the pointer actually was.
          onSignal({ progress: 0, pointer: { x: smoothX, y: smoothY }, velocity: 0 })
          havePosition = false
        }

        rafId = requestAnimationFrame(tick)
      }

      target.addEventListener('pointermove', onMove as EventListener)
      target.addEventListener('pointerleave', onLeaveWindow)
      rafId = requestAnimationFrame(tick)

      return () => {
        target.removeEventListener('pointermove', onMove as EventListener)
        target.removeEventListener('pointerleave', onLeaveWindow)
        if (rafId !== null) cancelAnimationFrame(rafId)
      }
    },
  }
}
