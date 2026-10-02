<h1 align="center">comice</h1>

<h3 align="center">
  A GPU interaction engine for images and video, with native scroll, hover, pointer, drag, click, time, and audio drivers.
</h3>

<p align="center">
  <img src="https://img.shields.io/badge/status-pre--release-orange" alt="Pre-release" />&nbsp;
  <img src="https://img.shields.io/badge/dependencies-0-20C55C" alt="Zero dependencies" />&nbsp;
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-strict-20C55C" alt="TypeScript" /></a>&nbsp;
  <img src="https://img.shields.io/badge/node-%3E%3D18-20C55C" alt="Node >=18" />&nbsp;
  <img src="https://img.shields.io/badge/license-MIT-20C55C" alt="MIT License" />
</p>

---

## Overview

A web page normally draws an image by handing it to the browser and letting the browser paint it, and you get no say over individual pixels. Comice puts that image or video on the graphics card instead, as a texture on a flat rectangle that sits exactly where the original element was. Once it's there, a small program runs over every pixel every frame, and that program can react to scrolling, the cursor, a drag, or audio.

That's the whole idea. Everything else is plugins deciding what that per-pixel program does. Underneath, every plugin is driven by a **state machine** (`idle → entering → active → leaving`), reacting to real events rather than a timeline of guessed durations. Interrupt one mid-transition and it reverses from wherever it actually is, rather than snapping back to a hardcoded start.

```js
comice('.hero')
  .use(distort())
  .driver(audio({ source: '#track' }))
  .map('bass').to(distort_instance, 'amount', { output: [0, 0.8], smoothing: 0.15 })
```

`distort()` never mentions audio. `audio()` never mentions distort. The mapping in between is the only thing that knows both names exist, so every driver works with every plugin without either side being rewritten for the other.

### A different layer than GSAP

GSAP and Motion animate properties: move this left, fade that to half opacity, count a number up. A property is the whole element at once, so no animation library can reach inside a picture and change what individual pixels are doing, turn a video into dots, or make a headline sit behind someone's shoulder. That's not a gap in GSAP, it's a different layer, working one level deeper.

The natural setup is GSAP (or Motion, or Lenis) drives, Comice renders: a timeline produces a number from 0 to 1, and Comice turns that number into per-pixel work. Nobody has to throw away what they already use.

---

## Status

**Pre-release.** The state machine, all seven drivers, the Driver → Signal → Mapping → Plugin Parameter layer, the full WebGL2 pipeline (texture-on-plane, multi-texture residency, the mask field, temporal feedback, the noise/displacement library), and fourteen plugins are built and tested — `reveal`, `morph`, `dissolve`, `distort`, `spotlight`, `rail`, `color`, `seed`, `mosaic`, `ascii`, `aura`, `type`, `layout`, `particles`. Every plugin ships either its complete spec card or a documented, tested subset — never a placeholder. Not yet published to npm. See [`ROADMAP.md`](./ROADMAP.md) for the full per-file status and what's next (it's gitignored, internal notes, read it locally rather than on GitHub).

---

## Architecture

```
comice/                required, under 10 kB, zero effects
  ├── the state machine (idle/entering/active/leaving)
  ├── native drivers (scroll, hover, pointer, drag, click, time — no dependency on anything)
  ├── the shared render loop (one requestAnimationFrame for every instance on the page)
  └── the Driver → Signal → Mapping → Plugin Parameter layer

comice/gl              opt-in, its own bundle entry — the WebGL2 pipeline
                        (texture-on-plane, multi-texture residency, the
                        mask field, temporal feedback, noise/displacement)

comice/drivers/audio   opt-in, its own bundle entry, importing comice
                        core never pulls in Web Audio boilerplate

@comice/*              opt-in plugins, built and tested: reveal, morph,
                        dissolve, distort, spotlight, rail, color, seed,
                        mosaic, ascii, aura, type, layout, particles.
                        Not yet published to npm.
```

Comice core ships with **zero effects**. Every visual effect is a plugin, registered explicitly and tree-shaken when unused, the same shape GSAP uses (core changes a number over time; ScrollTrigger and SplitText are separate add-ons), except Comice's core puts media on the GPU rather than tweening DOM properties.

### Core methods

| | |
|---|---|
| `comice(target)` | Wraps a CSS selector, an element, or a NodeList. Returns a chainable handle (or an array of them for multiple matches). |
| `.use(plugin)` | Attaches a plugin. Chainable. One GPU effect per element: a second shader plugin on the same element throws, naming both, instead of silently replacing the first. |
| `.driver(driver)` | Attaches an input source, `scroll()`, `hover()`, `pointer()`, `audio()`, or a custom one. |
| `.map(sourceKey).to(plugin, paramName, options)` | Routes one named signal from the most recently attached driver into one plugin parameter, through a clamp/remap/invert/multiplier/offset/easing/smoothing pipeline. |
| `.set(props)` / `.set(plugin, props)` | Applies values immediately, no transition (like `gsap.set()`): plugin parameters by name, plus `progress`. Scoped to one plugin when two share a parameter name. |
| `.transition(state)` | Forces a state change through the normal interrupt-safe rules. |
| `.on(event, fn)` / `.off()` | State and lifecycle events: `active`, `leaving`, `entering`, `idle`, `progress`, `rest`, `display`. |
| `.destroy()` | Tears down every driver and plugin attached to this instance and releases its resources. |

### Drivers

`scroll()`, `hover()`, `pointer()`, `drag()`, `click()`, and `time()` each drive the state machine directly through a single `progress` value (0..1) — all six state-machine drivers are built. `click()` and `hover()` animate progress over a `duration` (default 400ms) and reverse mid-way when interrupted. `audio()` is different: it's a `NamedSignalDriver`, reporting a bag of named values every frame (`bass`, `mid`, `high`, `energy`, `amplitude`, `spectrum`) plus discrete `beat`/`onset`/`drop` events, routed to plugin parameters through `.map()` rather than driving `progress` directly, since audio has no single honest notion of "how far along" it is.

### Where a plugin's work lands

Every plugin reduces to one of five operations: **merge** (many pieces become one), **breakout** (one piece becomes many), **distribute** (pieces travel into an arrangement), **mask** (media takes the shape of something), or **recompose** (one layout becomes another). The full catalogue is 18 plugins across this shape. Fifteen ship today — `reveal`, `morph`, `dissolve`, `distort`, `spotlight`, `rail`, `color`, `seed`, `mosaic`, `ascii`, `aura`, `type`, `layout`, `particles`, `persist` — each with either its complete spec card or a genuine, documented, tested subset. The remaining three — `vision`, `spatial`, `footage` — wait on `vision` (on-device ML for depth/segmentation), which needs its own design pass before it or anything depending on it can be built.

### Built-in budgets

- **Render only when visible.** Effects scrolled off screen or in a hidden tab do no work.
- **Frame budget.** When a device keeps missing ~40fps for two seconds, effects step down to 75% resolution, then 50%, then hold their last frame as a still. `setAdaptiveQuality(false)` opts out; `qualityLevel()` reports the current level.
- **Reduced motion.** With `prefers-reduced-motion`, effects that move jump straight to their end state; effects that only change how media looks (colour grading, placeholders, text wrap) keep working. `prefersReducedMotion()` exposes the live setting.

### Design principles

1. **Core earns its size in every project.** Nothing enters core unless every user needs it. Target: under 10 kB.
2. **Plugins are peers, not favourites.** Official plugins use the same public API a stranger would.
3. **Degrade, never disappear.** No GPU, reduced motion, a weak phone, a failed load: the media still shows.
4. **The page stays real.** Real text, real links, real layout underneath. The canvas mirrors the page, it never replaces it.
5. **States, not durations.** Every interactive plugin is a state machine driven by real events, interrupt-safe by construction.

---

## Development

```bash
pnpm install
pnpm build           # tsup build across all packages
pnpm typecheck        # tsc --noEmit across all packages
pnpm test             # bun test
pnpm test:coverage     # bun test --coverage, enforces 100% line/function coverage on every package
pnpm size              # size-limit check against the 10kB core budget
```

Requires Node ≥18 and pnpm ≥10. Tests run on [Bun](https://bun.sh)'s test runner.

---

## License

MIT
