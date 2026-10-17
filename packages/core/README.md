# comice

A GPU interaction engine for images and video.

Comice puts images and video on the graphics card, keeps them locked to the page, and lets them react to scrolling, the cursor, a drag, or a click, pixel by pixel. Core has zero effects and zero dependencies; every effect is an `@comice/*` plugin you add only when you need it.

## Install

```bash
npm install comice
```

## Use

```js
import { comice, pointer } from 'comice'
import { distort } from '@comice/distort'

comice('.hero img')
  .use(distort({ effect: 'bulge' }))
  .driver(pointer())
```

A plugin decides what happens to the media. A driver decides when. Any plugin works with any driver.

## Core methods

| | |
|---|---|
| `comice(target)` | Wraps a CSS selector, an element, or a NodeList. Always returns one chainable handle: for several matches, every call applies to each element, and each gets its own copy of every plugin (via the plugin's `create()`). `.handles` lists the per-element handles; no matches gives a handle that does nothing. |
| `.use(plugin)` | Attaches a plugin. One GPU effect per element: a second shader plugin on the same element throws, naming both. |
| `.driver(driver)` | Attaches an input. |
| `.set(props)` / `.set(plugin, props)` | Applies values immediately, no transition (like `gsap.set()`). |
| `.transition(state)` | Forces a state change through the normal interrupt-safe rules. |
| `.map(signal).to(plugin, param, options)` | Routes a named signal (from `audio()`) into a plugin parameter. |
| `.on(event, fn)` / `.off()` | State events (`idle`, `entering`, `active`, `leaving`, `progress`) and lifecycle events: `ready` when a plugin's effect is first on screen, `error` (with the reason) when it can't run. |
| `.destroy()` | Tears everything down and releases GPU resources. |

```js
comice('.hero img')
  .use(distort())
  .on('error', (_state, { plugin, error }) => console.warn(plugin, error.message))
```

Every interactive element is a state machine — `idle`, `entering`, `active`, `leaving` — driven by real events, so an interrupted hover or an early drag release reverses from wherever it is instead of restarting.

## Drivers

`scroll()`, `pointer()`, `hover()`, `click()`, `drag()`, `time()` and `audio()`. No ScrollTrigger needed: `scroll()` runs 0 as the element enters the bottom of the viewport (or `root`) to 1 as it leaves the top, using the browser's native view timeline where it exists. `click()` and `hover()` animate over a `duration` (default 400ms).

### `scroll()` options

| Option | |
|---|---|
| `subject` | Measure a surrounding section instead of the driven media (sticky stages). |
| `range` | `'cover'` (enters at the bottom, exits at the top; the default) or `'contain'` (section top at the top to its bottom at the bottom). |
| `smooth` | Seconds the progress takes to catch up with the scroll, so it glides behind the wheel instead of tracking it frame for frame: the scrub of a ScrollTrigger, with no library. About 95% of the way in `smooth` seconds, easing out, idle once it arrives. `.2` to `.4` reads as polish; much longer reads as drag. Skipped with `prefers-reduced-motion`. Default 0. |
| `threshold`, `offset`, `root` | Reshape the range, or measure inside a scroll container. |

```js
comice('#hero').use(morph({ from })).driver(scroll({ subject: '#stage', range: 'contain', smooth: .3 }))
```

### `audio()`

Turns a playing `<audio>` or `<video>` (or any Web Audio node) into signals you map onto plugin parameters: `bass`, `mid`, `high`, `energy`, `amplitude` and a `spectrum` array, plus `beat`, `onset` and `drop` events.

```js
comice('.hero')
  .use(distort())
  .driver(audio({ source: '#track', normalize: true, attack: 40, release: 320 }))
  .map('bass').to(distort, 'strength')
```

| Option | |
|---|---|
| `source` | A selector, a media element or an audio node. Default: an `<audio>` or `<video>` inside the target. |
| `normalize` | Automatic gain. Each signal is rescaled against its own recent quietest and loudest moments, so any track fills 0 to 1 with no hand-tuned `range`, and silence stays 0. `{ window }` sets how many seconds that takes to follow the music (default 8). Default off, so signals are raw. |
| `attack`, `release` | Milliseconds a signal takes to rise and to fall. A short attack with a longer release keeps hits punchy and the fall fluid. Default none. |
| `bands`, `fftSize`, `smoothing` | Resolution of the `spectrum` array and the analyser. |
| `onBeat`, `onOnset`, `onDrop` | Callbacks for detected events. Detection always uses the raw level. |

## Built-in budgets

- **Render only when visible.** Effects off screen or in a hidden tab do no work.
- **Frame budget.** When a device keeps missing ~40fps, effects step down to 75% resolution, then 50%, then hold their last frame as a still. `setAdaptiveQuality(false)` opts out.
- **Reduced motion.** With `prefers-reduced-motion`, effects that move jump to their end state; effects that only change how media looks keep working.
- **No GPU, failed load:** the media still shows.

## Plugins

`@comice/reveal`, `morph`, `dissolve`, `distort`, `spotlight`, `rail`, `color`, `seed`, `mosaic`, `ascii`, `aura`, `type`, `layout`, `particles`, `persist`.

## License

MIT © Olawale Balo

## Sticky sections and independent input mappings

`scroll({ subject: '#section', range: 'contain' })` measures the surrounding
section from its top reaching the viewport top to its bottom reaching the
viewport bottom. This lets a sticky media surface cover the whole 0–1 progress
range. The default `range: 'cover'` keeps the original enter/exit behavior.
Explicit `root` containers always measure against that root, including on
browsers with native ViewTimeline support. Native progress is sampled by the
shared scheduler; shader updates run on the main thread.

Mappings stay bound to the driver most recently attached when `.map()` was
called, so adding another driver cannot redirect existing mappings. Plain
drivers also expose `progress`, `pointerX`, `pointerY`, and `velocity` for mapping.
Initial synchronous signals are applied as soon as `.to()` is attached.

Destroy is idempotent. Attaching plugins/drivers to a destroyed handle throws.
A plugin instance cannot be attached to two live handles; use `create()` or a
new instance. Failed group plugin setup rolls back the newly attached copies.
Continuous progress changes reverse entering/leaving states without resetting
progress; a single endpoint signal settles through the legal state transitions.
Group mapping builders preserve that same driver binding. Destroy clears mappings
and rejects new ones, including builders captured before destruction. Failed driver
attachments ignore late signals.

SVG media URLs are rasterized at their decoded size before GPU upload, preserving
alpha and avoiding Chromium's direct SVG upload errors. Shared media planes abort
pending readiness listeners on teardown and recover when a failed source reloads.

Rasterized masks can expose opaque component centers with `components: true`.
Their default SDF storage is R8; `precision: 'half'` uses a normalized R16F field
for gradual interpolation across larger distances, through the same mask sampler.

Half-float rasterized SDFs (`precision: 'half'`) store signed distances in bake
texels around zero, preserving fractional vector edge coverage. Their producer
reports `distanceEncoding: 'signed'`; convert to UV distance using bake height.
Byte SDFs retain normalized encoding with the boundary at .5. Coverage masks
remain normalized. This avoids half-float quantization around a .5 bias.

SDF bakes use an exact Euclidean distance transform. With `background: true`,
the transform, encoding and island search run on a small pool of workers built
from the same functions, so mounting an effect never stalls scrolling;
`rasterize()` then resolves `true` once the new field is on the GPU (or `false`
if a newer bake replaced it), and the previous field stays in use until then.
Where workers are unavailable (a strict CSP), bakes run on the main thread.

Video planes upload only frames the video has actually presented
(`requestVideoFrameCallback`), not one per tick, and `plane.frame` counts uploads
so a plugin can skip redrawing an unchanged frame. A canvas mounted with
`hideTarget: false` can `hideTarget(fadeMs)` once it has drawn, crossfading in
over the media instead of switching. Mounting an effect briefly pauses the
frame-budget measurement, since setup cost is not sustained rendering cost.
