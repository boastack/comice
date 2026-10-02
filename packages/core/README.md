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
| `comice(target)` | Wraps a CSS selector, an element, or a NodeList. Returns a chainable handle (an array of them for several matches). |
| `.use(plugin)` | Attaches a plugin. One GPU effect per element: a second shader plugin on the same element throws, naming both. |
| `.driver(driver)` | Attaches an input. |
| `.set(props)` / `.set(plugin, props)` | Applies values immediately, no transition (like `gsap.set()`). |
| `.transition(state)` | Forces a state change through the normal interrupt-safe rules. |
| `.map(signal).to(plugin, param, options)` | Routes a named signal (from `audio()`) into a plugin parameter. |
| `.on(event, fn)` / `.off()` | State and lifecycle events. |
| `.destroy()` | Tears everything down and releases GPU resources. |

Every interactive element is a state machine — `idle`, `entering`, `active`, `leaving` — driven by real events, so an interrupted hover or an early drag release reverses from wherever it is instead of restarting.

## Drivers

`scroll()`, `pointer()`, `hover()`, `click()`, `drag()`, `time()` and `audio()`. No ScrollTrigger needed: scroll uses the browser's native ScrollTimeline where it exists. `click()` and `hover()` animate over a `duration` (default 400ms).

## Built-in budgets

- **Render only when visible.** Effects off screen or in a hidden tab do no work.
- **Frame budget.** When a device keeps missing ~40fps, effects step down to 75% resolution, then 50%, then hold their last frame as a still. `setAdaptiveQuality(false)` opts out.
- **Reduced motion.** With `prefers-reduced-motion`, effects that move jump to their end state; effects that only change how media looks keep working.
- **No GPU, failed load:** the media still shows.

## Plugins

`@comice/reveal`, `morph`, `dissolve`, `distort`, `spotlight`, `rail`, `color`, `seed`, `mosaic`, `ascii`, `aura`, `type`, `layout`, `particles`, `persist`.

## License

MIT © Olawale Balo
