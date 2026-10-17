# @comice/particles

Media as a cloud of points, and media broken into tiles.

A plugin for [Comice](https://github.com/boastack/comice), a GPU interaction engine for images and video.

## Install

```bash
npm install comice @comice/particles
```

## Use

Target: a container element, the stage. Sources are cover-fitted to its shape.

```js
import { comice, scroll } from 'comice'
import { particles } from '@comice/particles'

// A portrait breaking into 120,000 drifting points that reassemble into
// the wordmark as the page scrolls.
comice('#stage').use(particles({
  mode: 'cloud',
  from: { image: '/founder.jpg' },
  to: { text: 'COMICE' },
  count: 120000,
  motion: { noise: 0.3 },
})).driver(scroll())

// A hero image breaking into a hundred squares and coming back.
comice('#hero').use(particles({ mode: 'shatter', from: imageA, to: imageB })).driver(scroll())
```

Progress 0 is `from`, exactly; 1 is `to`, exactly (or `from` again, without one). In between, the points or tiles scatter, drift and spin.

## Options

| Option | Type | |
|---|---|---|
| `from` | source | **Required.** What the points start as. |
| `to` | source | What they become. Without it they break apart and come back. |
| `mode` | `'cloud'` \| `'shatter'` | Points, or tiles that are real pieces of the picture. Default `'cloud'`. |
| `count` | number | About how many points or tiles. Transparent areas get none. Default 20000 for cloud, 100 for shatter. |
| `motion` | `{ fluid, noise }` | Drift in flight: `noise` 0 to 1; `fluid: true` alone is a gentle 0.2. Default none. |
| `scatter` | number | How far they fly apart mid-way, as a fraction of the stage. Default 0.12 for cloud, 0.3 for shatter. |
| `reassemble` | boolean | Each point returns to its own place. `false` lands them in shuffled order, so the picture forms out of a swirl. Default `true`, except into text. |
| `size` | number | Point size, CSS px. Default: one grid cell, so the picture is solid at rest. |

A source is an `<img>` or `<video>`, `{ image }` or `{ video }` (an element or a URL), or `{ text, font?, color? }`. Text is drawn in the stage's own font and colour unless you give them, and waits for web fonts to load. Video stays live. Cross-origin media needs CORS headers; without them the `error` event says so.

Does no work while off screen or in a hidden tab. With `prefers-reduced-motion` the points jump to their end state and stop drifting. Without WebGL2 the container is left as it is.

## License

MIT © 2026 [Olawale Balo](https://github.com/walebuilds)
