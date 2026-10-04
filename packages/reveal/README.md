# @comice/reveal

Media entering, leaving and expanding — the first Comice plugin.

A plugin for [Comice](https://github.com/boastack/comice), a GPU interaction engine for images and video.

## Install

```bash
npm install comice @comice/reveal
```

## Use

Target: any element.

```js
import { comice, scroll } from 'comice'
import { reveal } from '@comice/reveal'

comice('.section img')
  .use(reveal({ effect: 'wipe' }))
  .driver(scroll({ threshold: 0.3 }))
```

The media can also enter through a mask — a shape, text, another image, or the cursor:

```js
import { comice, pointer, scroll } from 'comice'
import { reveal } from '@comice/reveal'

comice('.photo').use(reveal({ mask: { type: 'cursor', radius: 200, softness: 0.4 } })).driver(pointer())
comice('.photo').use(reveal({ mask: { type: 'text', text: 'COMICE' } })).driver(scroll())
```

With no driver, reveal plays itself the first time the element comes into view; a stagger then runs as the grid scrolls in:

```js
comice('.grid figure').use(reveal({ effect: 'blinds', stagger: { each: 0.06, grid: 'auto' } }))
```

With a driver, the driver sets the timing.

## Options

| Option | Type | |
|---|---|---|
| `effect` | `'mask'` `'wipe'` `'scale'` `'blur'` `'blinds'` `'slats'` `'curtain'` `'expand'` | How the element enters. Default `'mask'` when a `mask` is given, otherwise `'scale'`. |
| `mask` | cursor \| shape \| text \| `<img>` \| `<video>` | For `'mask'`: `{ type: 'cursor', radius, softness }`, `{ type: 'shape', path, viewBox? }` (fitted to the media), `{ type: 'text', text }` (centred), or another image or video: read by its alpha when it has transparency (a logo's silhouette), by brightness when it's opaque; `{ source, channel: 'luminance' | 'alpha' }` chooses. Needs an `<img>`/`<video>` target. `'subject'`/`'depth'` need `@comice/vision` (not built yet). |
| `stagger` | `{ each, from, grid, random }` | Several elements entering together. `each`: seconds between steps (default 0.06). `grid: 'auto'`: the items' rows and columns are read from the page, and the delay grows with distance from `from` (`'start'`, `'center'`, `'end'`); `[rows, columns]` gives the grid. `random`: up to this many seconds of jitter. |
| `duration` | number | With no driver: how long the reveal plays, ms. Default 800. |
| `waitForDecode` | boolean | Never reveal a blank frame. Default `true`. |

With `prefers-reduced-motion` the element appears in its end state instead of animating in.

## License

MIT © Olawale Balo
