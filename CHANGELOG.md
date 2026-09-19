# Changelog

All notable changes to Comice are documented in this file. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/); Comice has not made its first release yet, so there is no version section below — this tracks progress toward `0.1.0`.

## [Unreleased]

### Added

- Core state machine (`idle → entering → active → leaving`), interrupt-safe, with a single `applyState → emit` mutation pipeline and a `rest`/`display` transform split so one element's hover can't leak into another element's field-distance math.
- Shared render loop: one `requestAnimationFrame` for every Comice instance on the page, with `IntersectionObserver`/`visibilitychange` gating so off-screen or backgrounded instances don't tick.
- Public API: `comice()`, `.use()`, `.driver()`, `.on()`/`.off()`, `.destroy()`.
- Native drivers with no external dependency: `scroll()` (native `ScrollTimeline` where supported, `getBoundingClientRect` fallback otherwise), `hover()` (intent debounce), `pointer()` (continuous position/velocity within a radius, frame-rate-independent smoothing).
- The Driver → Signal → Mapping → Plugin Parameter layer: `NamedSignalDriver`, `MappableTarget`, and `.map(sourceKey).to(plugin, paramName, options)` — a pure clamp/remap/invert/multiplier/offset/easing/smoothing pipeline that lets any driver's named signals control any plugin's parameters without either side depending on the other.
- `audio()` driver (`comice/drivers/audio`, its own bundle entry, never pulled into core's main bundle): Web Audio `AnalyserNode`-based, reports `bass`/`mid`/`high`/`energy`/`amplitude`/`spectrum` every frame plus `beat`/`onset`/`drop` events via a lightweight rolling-average onset detector.
- Crash isolation across the shared scheduler, `.destroy()` teardowns, `.map()` mapping application, and every `.on()` listener notification — one throwing plugin/driver/listener can no longer silently take down the shared loop or block other cleanup/notifications.
- Construction-time validation on `.map().to()` options: malformed config (reversed ranges, non-finite numbers, out-of-bounds smoothing) throws immediately; bad runtime signal data degrades silently instead.
- 100% line/function test coverage enforced on every file in `packages/core/src/`.

### Notes

- No plugins have shipped yet. `reveal` is next (see `ROADMAP.md`).
- Not yet published to npm.
