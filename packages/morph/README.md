# @comice/morph

Media changing shape — five operations over signed distance fields.

A plugin for [Comice](https://github.com/boastack/comice), a GPU interaction engine for images and video.

## Install

```bash
npm install comice @comice/morph
```

## Use

Target: an `<img>` or `<video>`.

```js
import { comice, scroll } from 'comice'
import { morph } from '@comice/morph'

comice('.hero img')
  .use(morph({ operation: 'breakout', count: 3 }))
  .driver(scroll())

// The footage collapses into a logo; the connecting tissue stretches and snaps.
comice('#film').use(morph({
  operation: 'mask', into: 'svg', path: 'M12 2L2 7l10 5 10-5-10-5z',
  liquid: 0.7, thread: { sag: 6, dissolve: 4 },
})).driver(scroll())
```

## Options

| Option | Type | |
|---|---|---|
| `operation` | `'merge'` `'breakout'` `'distribute'` `'mask'` `'recompose'` | **Required.** |
| `layout` | string | Arrangement the pieces travel into. |
| `into` | `'svg'` \| `'text'` | For `'mask'`: what the media takes the shape of, with `path` (SVG path data) or `text`. The shape is fitted to the media, centred; `viewBox` sets the path's coordinate box (measured from the path when left out). `mask: { type: 'shape', path }` says the same thing. |
| `count` | number | Number of pieces. |
| `liquid` | number | How much shapes blend into each other, 0 to 1. Default 0.5. |
| `order` | `'sequence'` \| `'alternate'` | The order the pieces move in: one after another, or dealt outward from the centre. Default `'sequence'`. |
| `thread` | `{ width, pinch, sag, dissolve }` | A stretching bridge between separating pieces, so they break rather than simply stop touching; on `'mask'`, strands holding drops at the frame's corners until they snap. `width`, `sag` and `dissolve` (how deeply it tears) in px, `pinch` 0 to 1. Defaults 8, 0.4, 10, 3. |

Does no work while off screen or in a hidden tab, and steps down resolution on devices that can't keep up. Without WebGL2 the original media shows, unchanged. With `prefers-reduced-motion` it jumps to its end state instead of animating.

## License

MIT © Olawale Balo
