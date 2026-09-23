# Changelog

All notable changes to Comice are documented in this file. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/); Comice has not made its first release yet, so there is no version section below — this tracks progress toward `0.1.0`.

## [Unreleased]

### Added

- Core state machine (`idle → entering → active → leaving`), interrupt-safe, with a single `applyState → emit` mutation pipeline and a `rest`/`display` transform split so one element's hover can't leak into another element's field-distance math.
- Shared render loop: one `requestAnimationFrame` for every Comice instance on the page, with `IntersectionObserver`/`visibilitychange` gating so off-screen or backgrounded instances don't tick.
- Public API: `comice()`, `.use()`, `.driver()`, `.on()`/`.off()`, `.destroy()`.
- All seven drivers, no external dependency: `scroll()` (native `ScrollTimeline` where supported, `getBoundingClientRect` fallback otherwise), `hover()` (intent debounce), `pointer()` (continuous position/velocity within a radius, frame-rate-independent smoothing), `drag()` (pointer/touch drag with momentum), `click()` (single discrete event, optional toggle), `time()` (duration/loop, the one driver that behaves like a classic tween), `audio()` (`comice/drivers/audio`, its own bundle entry: Web Audio `AnalyserNode`-based, reports `bass`/`mid`/`high`/`energy`/`amplitude`/`spectrum` every frame plus `beat`/`onset`/`drop` events).
- The Driver → Signal → Mapping → Plugin Parameter layer: `NamedSignalDriver`, `MappableTarget`, and `.map(sourceKey).to(plugin, paramName, options)` — a pure clamp/remap/invert/multiplier/offset/easing/smoothing pipeline that lets any driver's named signals control any plugin's parameters without either side depending on the other.
- The full WebGL2 pipeline (`comice/gl`, its own bundle entry): texture-on-plane upload/draw, multi-texture residency (per-frame texture-unit budgeting for A↔B blends), the mask field (cursor/shape/text/image/video/subject/depth, one shared GLSL sampling chunk), a temporal feedback ping-pong buffer pair, and a simplex/curl noise + displacement GLSL library.
- Fourteen plugins: `reveal` (entering/leaving/expanding, pure CSS), `morph` (all five spec operations — merge/breakout/distribute/mask/recompose — plus the `thread` stretching-bridge option), `dissolve` (crossfade/noise/liquid transitions), `distort` (bulge/lens/glass field presets), `spotlight` (peer dim/blur, DOM caption reveal), `rail` (all seven layout modes — canvas/strip/compare/stack/marquee/arc/coverflow — with its own drag/inertia physics), `color` (composable duotone/lut/grain/bloom/aberration effect stack), `seed` (thumbhash/blurhash/lqip placeholders, real decode-wait), `mosaic` (dither/halftone/riso/pixelate/crosshatch/images fills), `ascii` (SDF glyph-atlas character reconstruction), `aura` (edge/palette color sampling pushed into CSS variables/glow/callback), `type` (fill/behind/knockout/melt, pure CSS), `layout` (wrap/avoid/anchor via `shape-outside`), `particles` (cloud/shatter, instanced GPU geometry with real per-particle A↔B targets).
- Crash isolation across the shared scheduler, `.destroy()` teardowns, `.map()` mapping application, and every `.on()` listener notification — one throwing plugin/driver/listener can no longer silently take down the shared loop or block other cleanup/notifications.
- Construction-time validation on `.map().to()` options: malformed config (reversed ranges, non-finite numbers, out-of-bounds smoothing) throws immediately; bad runtime signal data degrades silently instead.
- 100% line/function test coverage enforced on every file in every package (1050+ tests).

### Notes

- Fourteen of eighteen planned plugins ship. The remaining four (`vision`, `spatial`, `footage`, `persist`) are blocked on `vision` (on-device ML for depth/segmentation), which needs its own design pass.
- Not yet published to npm.
