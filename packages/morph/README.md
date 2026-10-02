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
```

## Options

| Option | Type | |
|---|---|---|
| `operation` | `'merge'` `'breakout'` `'distribute'` `'mask'` `'recompose'` | **Required.** |
| `layout` | string | Arrangement the pieces travel into. |
| `mask` | shape or text | For `'mask'`: what the media takes the shape of. |
| `count` | number | Number of pieces. |
| `liquid` | number | How much shapes blend into each other. |

Does no work while off screen or in a hidden tab, and steps down resolution on devices that can't keep up. Without WebGL2 the original media shows, unchanged. With `prefers-reduced-motion` it jumps to its end state instead of animating.

## License

MIT © Olawale Balo
