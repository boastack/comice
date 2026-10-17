# @comice/morph

Morph image or video silhouettes using **your SVG or CSS clip-path**. No built-in shape catalog.

```sh
npm install comice @comice/morph
```

```js
import { comice, scroll } from 'comice'
import { morph } from '@comice/morph'

const effect = morph({
  from: '/shapes/panels.svg', // Optional: the media's own frame otherwise.
  to: 'ellipse(45% 40% at center)', // Optional: the media's own frame otherwise. SVG and CSS inputs can be mixed.
  join: true,
  liquid: .7,
  outline: { style: 'sheen', width: 8, color: '#ffffff', opacity: .45 },
  liquidSheen: 0,
  glass: { width: 24, refraction: 18, fringe: 1.5, sheen: 0 },
})
const handle = comice('#film').use(effect)
  .driver(scroll({ subject: '#section', range: 'contain', smooth: .3 }))

// Or drive progress directly:
handle.set(effect, { progress: .5 })
// On removal:
// handle.destroy()
```

## Minimal integration

Give the media a defined size and a positioned parent. A scroll scene needs room
for the page to travel; `range: 'contain'` runs while the section contains the
viewport. The native scroll driver supplies progress automatically.

```html
<section id="section">
  <div class="stage">
    <img id="film" src="/photo.jpg" alt="Mountain landscape" />
  </div>
</section>
<style>
  #section { height: 200svh; }
  .stage { position: sticky; top: 0; height: 100svh; display: grid; place-items: center; }
  #film { display: block; width: min(80vw, 960px); height: min(60svh, 540px);
    object-fit: cover; border-radius: 16px; }
</style>
```

```js
import { comice, scroll } from 'comice'
import { morph } from '@comice/morph'

const effect = morph({ to: 'circle(40%)', liquid: 0 })
const handle = comice('#film').use(effect)
  .driver(scroll({ subject: '#section', range: 'contain', smooth: .3 }))
handle.on('error', (_, event) => console.error(event.error))

// Call from your component's unmount/dispose callback:
// handle.destroy()
```

For video, replace the image with `<video id="film" src="/film.mp4" muted loop
playsinline autoplay aria-label="Mountain landscape"></video>`. Playback belongs to
your application; handle a rejected `play()` promise if you start it in JavaScript.
Use root-relative asset URLs or `new URL('./shape.svg', import.meta.url).href` so
shape URLs continue to resolve after moving the example into a bundler project.

## The media's own frame

`from` and `to` are both optional. A missing end is the media's own frame: its CSS
`clip-path` if it has one, otherwise its box with whatever `border-radius` you set on the
image or video (any corner, elliptical, or a percentage like `50%`). So
`morph({ from: '/shapes/panels.svg' })` flows from your shape into the media exactly as you
styled it, with the corners you chose and no radius repeated in the options. The radius is
read when the effect mounts and again whenever the media resizes.

## Sound and controls

Morph never touches `muted`, `volume`, `play()`, `pause()` or `controls`: a video with sound
keeps playing its sound through the effect, and the page decides whether it is muted. The
media is hidden behind the effect (`visibility: hidden`, so it keeps decoding and playing),
which also hides the browser's native controls while the effect is on; use your own controls
if you need them. The canvas that replaces the media carries its accessible name (`alt`,
`aria-label` or `title`), and decorative media (`alt=""`) stays out of the accessibility tree.

## Shape inputs

`from` and `to` accept SVG URLs, complete SVG markup, SVG elements, decoded images,
core mask objects, or CSS clip-path strings. `{ clipPath: 'polygon(...)' }` is also
accepted. Full SVG preserves multiple pieces, groups, transforms, curves, definitions
and holes. Alpha defines the silhouette, including an opaque background if present.
External images need CORS. During preparation the original media is shown only
when its frame matches the requested silhouette; otherwise the canvas fades in
when ready. Load failures, context loss and a ten-second preparation timeout restore
the original media and emit an `error` event.

CSS supports `polygon()` (including `evenodd`), `circle()`, `ellipse()`, `inset()`
(including elliptical `round` corners), `path()` (including `evenodd` holes and SVG
curves), `rect()` and `xywh()`. Lengths accept `px`, `%`, zero and additive
`calc()` expressions such as `calc(100% - 16px)`. Positions accept one or two
keywords/coordinates. `border-box` is the coordinate reference; percentages resize
with the media. CSS `path()` uses absolute CSS pixels and is **not** automatically
fitted. Unsupported syntax fails with an error: other geometry boxes, `url()`,
`shape()`, variables, other units, edge-offset positions and complex CSS math need
conversion to SVG first.

```js
// Fan-shaped sector, supplied by the caller:
morph({ to: 'polygon(50% 100%, 0% 25%, 15% 10%, 35% 0%, 65% 0%, 85% 10%, 100% 25%)' })

// CSS to SVG; no matching point count required:
morph({ from: 'inset(12px round 24px)', to: '/brand.svg', join: true })

// Compound CSS path with a transparent hole:
morph({ to: `path(evenodd, 'M10 10H390V190H10Z M140 60H260V140H140Z')` })
```

Without `from`, Comice captures the target's computed CSS clip-path, or its frame
with all four CSS corner radii. Morphing uses signed distance fields, so endpoints
can have different numbers of paths, vertices, pieces and holes. It is silhouette
interpolation, rather than a correspondence between individual SVG vertices.

## Image or video to text

Text is a silhouette mask for the original image or video. Supply it at either
endpoint, or use two text endpoints to change the words while retaining the media fill.

```js
const effect = morph({
  from: { type: 'text', text: 'Olawale Balo', font: '700 160px Geist' },
  to: { type: 'text', text: 'Design Engineer', font: '700 160px Geist' },
  liquid: .25,
  cursorFollow: false,
  liquidSheen: 0,
  maskRasterization: { fill: .9 },
})
```

Omit `from` to morph the media's frame into text. Omit `to` to return from text
to the media's frame. Both `<img>` and `<video>` targets use the same API.
`font` accepts a CSS font shorthand. Define custom faces with `@font-face`;
Morph waits for the requested font before baking. Text is centered and uniformly
fitted to the available space, including custom fonts, overhangs and descenders.
`maskRasterization.fill` applies to both text endpoints. Resizing refits the words
and swaps their new distance fields together.

This is GPU silhouette interpolation with image or video pixels inside the letters,
not semantic text conversion or a per-character animation. Keep meaningful text
in the document or accessible media label. The final showcase example demonstrates
this transition with selectable video or photography inside both text silhouettes. Text-to-text
transitions smooth their intermediate distance fields to round intersecting glyph
contours; the supplied endpoint masks remain unchanged.

## Driving it from audio

`progress`, `mouseX`, `mouseY` and `velocity` are all mappable, so the shape can follow
music. `audio()` reports named signals (`bass`, `mid`, `high`, `energy`, `amplitude`);
map them onto the shape:

```js
import { comice } from 'comice'
import { audio } from 'comice/drivers/audio'
import { morph } from '@comice/morph'

const effect = morph({ from, to })
comice('#hero')
  .use(effect)
  .driver(audio({ source: '#track', normalize: true, attack: 40, release: 320 }))
  .map('bass').to(effect, 'progress')
  .map('high').to(effect, 'velocity', { output: [0, .9] })
```

The bass pushes the shape toward `to` and the treble flexes it through `bend`.
`normalize: true` levels each signal against the track's own quietest and loudest moments,
so there is no range to tune per song, and `attack` and `release` (milliseconds) keep a hit
punchy and the fall fluid. The music has to be playing for anything to move.

## Rendering cost and stable edges

The default mask bake uses one texel per CSS pixel (up to a 2048px longest axis),
independent of adaptive canvas rendering quality. A quality change does not change
the geometry or start a new bake. Resizing bakes the endpoint fields in the
background and draws them together once all are ready. Still images stop issuing
GPU draws after progress, parallax and pointer wakes settle; videos draw on new
media frames. Disabled glass and outlines use one media texture sample, and glass
with `fringe: 0` skips chromatic texture reads.

Start with `liquid: 0, cursorFollow: false` for an exact, quiet silhouette, then
add glass, outlines, bending or pointer interaction individually. The parallax
offset is bounded by the crop margin so it cannot smear repeated texture edges.
A byte distance field trades contour precision for storage; keep the default
half-float precision for intricate shapes. Call `destroy()` when removing media;
on long galleries mount effects near the viewport and release distant ones.

## Motion and surfaces

- `direction`: `forward` (default) or `reverse` across the entire progress domain.
- `liquid`: 0–1, default .5; controls wobble and slab smoothing.
- `join`: off by default. `true` grows midpoint drops following the supplied liquid
  frame reference. The endpoint with more separate opaque components determines
  joining or separation, so the same behavior works from a frame to pieces.
  Joins stay inside the combined input silhouettes, preserving their outer limits
  and shared holes instead of pushing expanding drops beyond the supplied shapes.
  Up to 32 major components get automatic connections; all pieces remain in the
  silhouette. Connections preserve both endpoints and their holes.
- `join: { style: 'metaball', points, width }`: optional normalized top-left
  `[x,y]` centers and initial radius in CSS pixels. Default radius is 6/688 of
  media height. Drops grow over progress 0–.15, merge over .10–.90, then settle
  over .85–1; separation uses the reverse profile.
- `join: { style: 'slab', pinch: .35, sag: 0, fillet: 8, thin: .4, dissolve: 2.9 }`:
  tapered connections adapted from Viscose. Thickness is inferred from supplied
  component fields; optional `width` overrides it in CSS pixels. The midpoint's
  distance field determines gap opening, driving thinning, sag and final fade
  below zero width so no hairline remains. `thin` is positive; pinch is 0–1.
  Slab sizes are CSS pixels.
- `liquidSheen`: moving midpoint-drop highlight intensity, default .45.
- `outline`: disabled by default; `style: 'stroke' | 'sheen'`, `width` in CSS
  pixels, hex `color`, `opacity` 0–1. Sheen defaults to 1.2% of height and .45
  opacity; an explicit 8px width stays 8px when resizing.
- `glass`: disabled by default; edge `width`, `refraction` and chromatic `fringe`
  in CSS pixels, plus `sheen` intensity. Optional `rim` (default 0) adds signed
  directional lighting: bright toward the light, dark away. Independent of joining and outline.
- `interaction`: off by default. `true` enables local pointer softening and a
  fading silhouette wake using the native core pointer driver. Progress remains
  independent; both endpoints and shared holes stay intact. Optional settings:
  `{ radius: 160, softness: 18, wake: 3, decay: .94 }`. Distances are CSS pixels;
  radius is positive and wake retention `decay` is in [0,1). Smoothing and decay
  use elapsed time. Hidden/offscreen effects pause; reduced motion suppresses interaction.
- `cursorFollow`: media parallax, default true. The media follows the pointer over the whole
  page by itself, eased as the legacy pages did, on devices with a hover-capable pointer.
  Pass `{ offset, zoom }` to tune it: `offset` is how far the media follows (default .035,
  0 or more) and `zoom` scales the media (default .95, in (0, 2]; the margin keeps the offset
  from showing an edge). Mapping or setting `mouseX` / `mouseY` yourself takes that axis over.
- `bend`: the shape flexes with how fast the page is scrolling, default off. `true` or
  `{ x, y }` (finite, 0 or more; legacy's index page uses `{ x: .02, y: .04 }`). It follows the
  page's scroll speed by itself; mapping or setting `velocity` yourself (an audio signal, say)
  takes over. Velocity is bounded to -1..1 for bending. The deformation stays inside the
  media box and eases to zero at both endpoints, keeping corners and top edges stable.
- `maskRasterization`: core raster settings. `fill` fits the `to` shape inside the media (for example .82 leaves a margin); `from` always fills the media, as it is authored at stage size. Default half-float distance fields
  preserve fractional vector edge coverage and use a capped 2048px longest axis. `sdf: false` is rejected.

Old `layout`, `operation`, `into`, `count`, `thread`, `order`, `stagger` and `via` options
are retired and rejected. The demo collection supplies its own geometry under
`demo/assets/images`; those assets are not included in the published package.

Reduced-motion settings snap to an endpoint. GPU resources, image loads, observers
and subscriptions release on `handle.destroy()`. Offscreen effects stop drawing.

See the [demo](../../demo/morph/index.html) for editable inputs and runnable code.
Viscose's MIT attribution is retained in this package's LICENSE.
