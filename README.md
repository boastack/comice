<h1 align="center">Comice</h1>

<h3 align="center">
  Comice is a GPU interaction engine for images, video, and typography, with native scroll, hover, pointer, drag, click, time, and audio drivers.
</h3>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#plugins">Plugins</a> ·
  <a href="#demos">Demos</a> ·
  <a href="#development">Development</a> ·
  <a href="./LICENSE">MIT license</a>
</p>

Comice connects media effects to scroll, hover, pointer movement, drag, click, time, and audio. Morph a video into an SVG silhouette, reveal a gallery as it enters the viewport, turn an image into particles, or let a soundtrack shape the visual treatment.

The core manages state, input, parameter mapping, and scheduling. Effects live in independent packages, so an application imports only the capabilities it uses. GPU plugins share a WebGL2 foundation; layout, loading, navigation, and text plugins also work with the DOM and CSS.

**Release status:** pre-release. This repository contains the working packages, local showcases, and regression harnesses. APIs may change before a stable release. The setup below uses the source workspace.

## Why Comice

- **One interaction model.** Connect plugins and drivers through a chainable API, or set progress from your application's own animation system.
- **Independent effects.** Choose from 15 plugins without loading the entire catalog. The core has no runtime dependencies.
- **Interruptible transitions.** Interactive state changes continue from their current progress when input reverses.
- **Media that remains part of the page.** Effects follow existing elements and preserve the original media as a fallback when GPU rendering fails.
- **Managed rendering.** A shared scheduler, visibility checks, adaptive quality, and explicit teardown control rendering cost.
- **Typed integration.** Packages include TypeScript declarations and ESM and CommonJS builds.

## Quick start

### Set up the repository

Install Node.js 18 or newer, pnpm 10 or newer, and Bun for the test runner and local server. The repository pins its pnpm version in [`package.json`](./package.json).

```sh
git clone https://github.com/boastack/comice.git
cd comice
pnpm install
pnpm build
pnpm demo
```

Open the [main showcase](http://localhost:8750/demo/) or [morph showcase](http://localhost:8750/demo/morph/). Keep the server running while exploring the examples. See [demo assets](#demo-assets) for media files that need to be supplied locally.

Inside an application package in this pnpm workspace, declare the packages you use as workspace dependencies:

```sh
pnpm add comice@workspace:* @comice/morph@workspace:*
```

### Create a scroll-driven morph

Give the media a defined size and place it inside a positioned stage. This section gives the page enough travel for the morph to reach both endpoints.

```html
<section id="scene">
  <div class="stage">
    <img id="hero" src="/images/landscape.jpg" alt="Mountain landscape" />
  </div>
</section>

<style>
  #scene { height: 200svh; }
  .stage {
    position: sticky;
    top: 0;
    height: 100svh;
    display: grid;
    place-items: center;
  }
  #hero {
    display: block;
    width: min(80vw, 960px);
    height: min(60svh, 540px);
    object-fit: cover;
    border-radius: 24px;
  }
</style>
```

```js
import { comice, scroll } from 'comice'
import { morph } from '@comice/morph'

const effect = morph({
  to: 'circle(40%)',
  liquid: 0,
  cursorFollow: false,
})

const handle = comice('#hero')
  .use(effect)
  .driver(scroll({ subject: '#scene', range: 'contain', smooth: 0.3 }))

handle.on('error', (_state, event) => {
  console.error(event.error)
})

// In your component's unmount or dispose callback:
// handle.destroy()
```

The starting shape comes from the media's computed CSS frame. Scroll forward to reach the circle and back to return. SVG URLs, SVG markup, CSS clip paths, and additional surface controls are documented in the [morph guide](./packages/morph/README.md).

For video, use a sized `<video>` element with `muted`, `playsinline`, and your application's playback controls. Comice does not start playback or manage audio permissions for you.

## How it works

```text
Input driver → Signals → Parameter mapping → Plugin → Media or DOM output
                         Core state and shared scheduling
```

A **driver** reads input. A **plugin** owns an effect. A **mapping** routes a driver signal into a plugin parameter. The core coordinates these pieces without requiring an effect to understand each input source.

Standard drivers can update the instance's progress from `0` to `1`. Audio exposes several named signals, which you map explicitly. The state machine tracks `idle`, `entering`, `active`, and `leaving` and emits events as progress changes.

### Core API

| Method | Purpose |
| --- | --- |
| `comice(target)` | Create a handle for a selector, element, or NodeList. Multiple matches receive separate plugin instances. |
| `.use(plugin)` | Attach a configured effect. |
| `.driver(driver)` | Attach an input source. |
| `.map(signal).to(plugin, parameter, options)` | Map a signal from the most recently attached driver to a plugin parameter. |
| `.set(values)` | Set progress or named plugin parameters immediately. |
| `.set(plugin, values)` | Set parameters on a specific attached plugin. |
| `.transition(state)` | Request a state transition. |
| `.on(event, callback)` / `.off(event, callback)` | Subscribe to or remove state and lifecycle listeners. |
| `.destroy()` | Detach drivers and plugins and release instance resources. |

Attach each plugin instance to one handle. When a selector matches several elements, official plugins provide fresh instances for each match. One element can own one GPU effect; attaching another GPU effect to that element produces an error. Use separate elements when an experience needs several rendered surfaces.

See the [core reference](./packages/core/README.md) for lifecycle events, mapping options, and custom plugin integration.

### Drivers

| Driver | Input | Import |
| --- | --- | --- |
| `scroll()` | Viewport or container progress, section ranges, optional smoothing | `comice` |
| `hover()` | Pointer entry and exit with reversible progress | `comice` |
| `pointer()` | Pointer position and interaction signals | `comice` |
| `drag()` | Drag progress with optional inertia | `comice` |
| `click()` | Click or tap transitions | `comice` |
| `time()` | Time-based progress | `comice` |
| `audio()` | Frequency bands, energy, amplitude, and beat callbacks | `comice/drivers/audio` |

Some plugins manage their own input. For example, rail owns its drag and keyboard interactions, and reveal can play when it enters the viewport without an attached driver. Each package documents its behavior.

### Map audio to an effect

This example assumes an existing image and a playing `<audio id="track">` element. Start playback through your application's controls in response to a user gesture.

```js
import { comice } from 'comice'
import { audio } from 'comice/drivers/audio'
import { distort } from '@comice/distort'

const effect = distort({ effect: 'bulge', anchor: [0.5, 0.5] })

const handle = comice('#hero')
  .use(effect)
  .driver(audio({
    source: '#track',
    normalize: true,
    attack: 40,
    release: 320,
  }))
  .map('bass').to(effect, 'strength', { output: [0, 0.8] })

// Dispose of the handle when this experience is removed.
// handle.destroy()
```

### Use an external animation system

Your application can supply progress directly, including from a router, a timeline, or another scroll controller:

```js
const effect = morph({ to: 'ellipse(45% 40%)', cursorFollow: false })
const handle = comice('#hero').use(effect)

function update(progress) {
  handle.set(effect, { progress })
}

update(0.5)
```

Use this approach when an existing system already owns timing. An additional Comice driver is optional.

## Plugins

Every plugin is an independent workspace package. Follow its guide for supported targets, options, mappable parameters, and limitations.

| Package | Capabilities |
| --- | --- |
| [`@comice/reveal`](./packages/reveal/README.md) | Viewport reveals, wipes, masks, blinds, scaling, and staggered entrances. |
| [`@comice/morph`](./packages/morph/README.md) | SVG and CSS silhouette morphing with optional joining, glass, outlines, and pointer interaction. |
| [`@comice/dissolve`](./packages/dissolve/README.md) | Transitions between images or videos, including noise, displacement, wipes, masks, and sequences. |
| [`@comice/distort`](./packages/distort/README.md) | Pointer fields, bulges, lenses, ripples, glass, and liquid distortion. |
| [`@comice/spotlight`](./packages/spotlight/README.md) | Focused items, peer dimming and blur, captions, and flexible expansion. |
| [`@comice/rail`](./packages/rail/README.md) | Interactive collections with strip, coverflow, compare, stack, marquee, arc, and canvas modes. |
| [`@comice/color`](./packages/color/README.md) | Duotone, LUT grading, grain, bloom, chromatic aberration, and hue shifts. |
| [`@comice/seed`](./packages/seed/README.md) | ThumbHash, BlurHash, and image placeholders, loading priority, and focal points. |
| [`@comice/mosaic`](./packages/mosaic/README.md) | Halftone, dithering, risograph, pixel, crosshatch, and image-tile treatments. |
| [`@comice/ascii`](./packages/ascii/README.md) | Live character-based image and video rendering. |
| [`@comice/aura`](./packages/aura/README.md) | Edge and palette sampling, ambient glow, and CSS color variables. |
| [`@comice/type`](./packages/type/README.md) | Media-text interaction, liquid transitions, and the GPU typography specification below. |
| [`@comice/layout`](./packages/layout/README.md) | Text wrapping, avoidance, anchoring, and responsive focal cropping. |
| [`@comice/particles`](./packages/particles/README.md) | Point clouds and image-tile shattering with image, text, and shape targets. |
| [`@comice/persist`](./packages/persist/README.md) | Shared media and playback continuity across client-side navigation. |

Vision-dependent features, including automatic subject detection and depth-based effects, are not implemented. Options that require them fail explicitly. Persist retains live media across client-side route changes; a full document reload cannot preserve the same live element.

## GPU typography specification

`@comice/type` owns expressive text surfaces, including standalone typography and text that interacts with images or video. The following effect families define its rendering scope.

| Effect family | Rendering behavior |
| --- | --- |
| Melt and liquid transitions | Merge and separate words or lines through text distance fields, with controlled viscosity, connecting necks, and clean endpoints. |
| Glyph and shape morphing | Interpolate text silhouettes into other words, logos, or SVG shapes while preserving holes and exact endpoint geometry. |
| Waves, bends, and stretching | Apply sine waves, arches, twists, elastic stretch, and squash to whole text or glyph groups without changing document layout. |
| Pointer fields and wakes | Use the pointer as a local bulge, lens, repulsion field, ripple source, or fading liquid wake. |
| Noise and displacement | Distort text with procedural turbulence, displacement maps, flowing noise, and directional ripples. |
| Glass and refraction | Refract image or video pixels through glyphs with optional chromatic fringe and directional edge lighting. |
| Media and gradient fills | Fill glyphs with images, playing video, animated gradients, or procedural textures; support knockout and media-text layering. |
| Strokes, glow, and surface finishes | Animate distance-based outlines, inner and outer glow, soft shadows, sheen, bevel-style shading, blur, and chromatic separation. |
| Reveals, masks, and dissolves | Reveal or remove text with wipes, clipping, noise thresholds, ink, erosion, scan lines, and pixel dissolves. |
| Glitch and pixel treatments | Apply channel offsets, scan distortion, displacement slices, pixelation, and halftone or dither treatments to text surfaces. |
| Glyph, word, and line motion | Offset, rotate, scale, stagger, and arrange GPU glyph groups along paths using shared progress and per-group timing. |
| Particle text | Sample glyphs into points that scatter, flow, attract to the pointer, and reassemble into text, images, or shapes. |
| Shatter and fragment transitions | Break a text surface into glyph pieces or tiles, then scatter and reassemble those fragments with intact endpoint coverage. |
| Trails, echoes, and feedback | Accumulate controlled motion trails, afterimages, and fluid smearing through shared temporal feedback buffers. |
| Audio-reactive typography | Map bass, frequency bands, energy, amplitude, and beat callbacks to any compatible text effect parameter. |

### Rendering contract

The rendering contract uses Comice's WebGL2 foundation, cached text geometry and textures, and distance-field masks where appropriate. Glyph groups use shared GPU resources rather than one canvas or context per letter. Driver signals map to text parameters through the existing mapping layer. Effects reuse shared mask, displacement, particle, and feedback primitives without dependencies between plugin packages. Settled effects stop drawing unless their media, procedural motion, or feedback still requires updates; offscreen and hidden effects pause.

Real HTML text is the content and layout source. The visual canvas is decorative and excluded from the accessibility tree. Native text remains visible and selectable at rest, with reduced motion, or after a rendering failure. During an active GPU effect, selection must restore the native text rather than leave selection invisible. Ordinary text continues to use browser rendering.

Rendering must preserve font loading, shaping, kerning, ligatures, complex scripts, multiline layout, text alignment, and responsive wrapping. Font changes, content edits, resizing, and pixel-density changes invalidate the relevant caches without stretching old glyphs or showing mixed frames. Effects must respect reduced motion, bound their drawing surfaces and feedback memory, preserve crisp endpoints, and release every resource on teardown. Validate these requirements across desktop browsers and physical mobile devices.

**Implementation status:** The current package implements fill, behind, knockout, and melt using DOM, CSS, and SVG filters. This section defines the GPU rendering specification; these effect families are not additional options in the current runtime API.

## Performance and accessibility

GPU effects use visibility checks and pause rendering when their target is offscreen or the document is hidden. Adaptive quality can reduce render resolution when sustained frame times exceed the budget. Import `qualityLevel()` and `setAdaptiveQuality()` from `comice` to inspect or control that behavior.

Morph keeps geometry bakes independent of adaptive canvas resolution. Resized endpoint fields become active together, and still-image rendering settles when progress and pointer interaction stop changing. Large galleries should mount effects near the viewport and destroy distant instances to release GPU contexts and textures.

Motion-sensitive effects respect `prefers-reduced-motion`. Keep meaningful alternative text, accessible controls, and keyboard navigation in the underlying document. GPU fallback preserves the original media when initialization or rendering fails. Invalid configuration still needs to be handled as an application error.

## Browser and integration requirements

- **GPU effects:** WebGL2 and a browser that permits GPU context creation. DOM and CSS plugins have their own requirements.
- **Media sizing:** Explicit dimensions or a stable aspect ratio, with a positioned parent for GPU overlays.
- **Cross-origin media:** Appropriate CORS headers and the media element's `crossorigin` configuration before loading.
- **Video and audio:** Application-owned playback, controls, and user-gesture handling.
- **Component frameworks:** Create handles after the DOM mounts and call `destroy()` during unmount or route disposal.
- **Server rendering:** Initialize DOM-dependent effects on the client.

The browser harnesses exercise Chromium, WebKit, Firefox, and selected mobile emulation profiles across different suites. Emulated mobile results do not replace testing on physical devices. See the [acceptance guide](./harness/acceptance/README.md) and [morph regression guide](./harness/morph/README.md) for exact coverage.

## Demos

Run `pnpm demo` from the repository root, then open:

| Page | Local address |
| --- | --- |
| Main plugin showcase | [localhost:8750/demo/](http://localhost:8750/demo/) |
| Morph showcase and inspector | [localhost:8750/demo/morph/](http://localhost:8750/demo/morph/) |

The morph showcase includes editable shapes, driver and surface controls, and copyable integration snippets. Its code lives in [`demo/morph/`](./demo/morph/README.md).

### Demo assets

All showcase images, SVG silhouettes, fonts, media, and shared helpers live in [`demo/assets/`](./demo/assets/README.md). The Morph directory contains only its page, styles, and behavior. Package builds include their declared distribution files rather than the demo assets.

The shared video and audio are included in Git and the hosted showcase:

```text
demo/assets/video/a.mp4
demo/assets/video/b.mp4
demo/assets/audio/fela.mp3       # Optional soundtrack
```

The [showcase guide](./demo/morph/README.md) explains local media behavior. Bundled Geist fonts retain their [Open Font License](./demo/assets/fonts/OFL.txt).

### Deploy the showcase to Vercel

Import this repository with the project root set to the repository root. The
included `vercel.json` runs `pnpm build:demo` and serves `.vercel-static/`.
The root URL redirects to `/demo/`, and the Morph showcase lives at `/demo/morph/`.

The static output includes the demo pages, shared audio and video, fonts, and the
built core, Morph, and Type modules. Source files, tests, and internal documents
stay outside the deployment. Run `pnpm build:demo` locally to check the output.

## Project structure

```text
packages/
  core/                  State machine, drivers, mappings, scheduler, WebGL utilities
  <plugin>/              Independent effect packages and package documentation
demo/
  assets/                Shared images, SVGs, fonts, media, and helpers
  morph/                 Morph showcase, inspector, and integration snippets
harness/
  acceptance/            Cross-browser interaction examples and local server
  morph/                 Geometry, GPU, inspector, and fast-scroll regressions
test/                    Unit tests and deterministic browser/GPU fixtures
comice.html              Historical design specification
```

`comice/gl` exposes shared rendering primitives for plugin authors. `comice/machine`, `comice/scheduler`, and `comice/mapping` provide focused core entry points. `comice/drivers/audio` keeps Web Audio code in its own import path.

The historical morph engine is retained under `harness/morph/legacy-engine/` for regression comparisons. The current public morph API is documented in its package guide; the historical design specification is not an API reference.

## Development

Run commands from the repository root. Build before running unit tests because some tests import built workspace entry points.

| Command | Purpose |
| --- | --- |
| `pnpm install` | Install workspace dependencies. |
| `pnpm build` | Build all packages with Turborepo and tsup. |
| `pnpm dev` | Rebuild packages as source files change. |
| `pnpm typecheck` | Check package TypeScript types. |
| `pnpm test` | Run the Bun unit test suite. |
| `pnpm test:coverage` | Run unit tests with the configured coverage thresholds. |
| `pnpm size` | Check the configured 10 kB core bundle budget. |
| `pnpm demo` | Build packages and start the showcase server on port 8750. |
| `pnpm acceptance` | Run the acceptance browser suite against a running server. |
| `pnpm test:morph` | Build and run morph parity, CSS geometry, demo, and inspector suites. |

Install the browser engines before running browser checks:

```sh
pnpm exec playwright install chromium webkit firefox
```

A typical validation run is:

```sh
pnpm build
pnpm typecheck
pnpm test
```

For browser checks, keep `bun harness/acceptance/serve.ts` running in another terminal, then run:

```sh
pnpm acceptance
pnpm test:morph
node harness/morph/fast-scroll.mjs
```

Browser reports, screenshots, and generated test bundles stay in ignored output directories. Detailed setup and suite-specific options are documented in the [acceptance](./harness/acceptance/README.md) and [morph](./harness/morph/README.md) guides.

## Contributing and support

Read [CONTRIBUTING.md](./CONTRIBUTING.md) for repository conventions and contribution checks. Keep changes focused, include validation relevant to the behavior, and document public API changes in the affected package.

Use [GitHub Issues](https://github.com/boastack/comice/issues) for reproducible bugs and feature proposals. Include the package, browser, a minimal reproduction, and expected behavior. Follow the [security policy](./SECURITY.md) when reporting vulnerabilities. Release notes are recorded in [CHANGELOG.md](./CHANGELOG.md).

## License

MIT © 2026 [Olawale Balo](https://github.com/walebuilds)
