/**
 * test/fake-intersection — a controllable IntersectionObserver for tests
 * ─────────────────────────────────────────────────────────────────────────────
 * createVisibilityGate() (scheduler.ts) treats an element as off-screen
 * until an IntersectionObserver reports it intersecting, and happy-dom's
 * never fires that callback on its own — so anything gated on visibility
 * (the audio driver, every GL plugin's render loop, video plane uploads)
 * never runs in a test without this.
 *
 * Reports every observed element as `visible` synchronously on observe()
 * (close to a real browser for an element already on screen), and
 * setVisible() re-reports all of them, standing in for a scroll.
 */

export type FakeIntersection = {
  /** Re-reports every observed element as on- or off-screen. */
  setVisible(visible: boolean): void
  uninstall(): void
}

export function installFakeIntersectionObserver(options: { visible?: boolean } = {}): FakeIntersection {
  const original = globalThis.IntersectionObserver
  let visible = options.visible ?? true
  const live = new Set<{ callback: IntersectionObserverCallback; targets: Set<Element>; self: IntersectionObserver }>()

  ;(globalThis as any).IntersectionObserver = class {
    private entry: { callback: IntersectionObserverCallback; targets: Set<Element>; self: IntersectionObserver }
    constructor(callback: IntersectionObserverCallback) {
      this.entry = { callback, targets: new Set(), self: this as unknown as IntersectionObserver }
      live.add(this.entry)
    }
    observe(target: Element): void {
      this.entry.targets.add(target)
      this.entry.callback([{ isIntersecting: visible, target } as IntersectionObserverEntry], this.entry.self)
    }
    disconnect(): void {
      live.delete(this.entry)
    }
  }

  return {
    setVisible(next: boolean): void {
      visible = next
      for (const { callback, targets, self } of live) {
        callback([...targets].map((target) => ({ isIntersecting: next, target }) as IntersectionObserverEntry), self)
      }
    },
    uninstall(): void {
      globalThis.IntersectionObserver = original
    },
  }
}
