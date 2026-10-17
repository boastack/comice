# @comice/mosaic

Media rebuilt from cells, still reading as a photograph.

A plugin for [Comice](https://github.com/boastack/comice), a GPU interaction engine for images and video.

## Install

```bash
npm install comice @comice/mosaic
```

## Use

Target: an `<img>` or `<video>`.

```js
import { comice, hover } from 'comice'
import { mosaic } from '@comice/mosaic'

comice('.card img')
  .use(mosaic({ fill: 'halftone', cell: 10 }))
  .driver(hover())
```

## Options

| Option | Type | |
|---|---|---|
| `fill` | `'dither'` `'halftone'` `'riso'` `'pixelate'` `'crosshatch'` `'images'` | **Required.** |
| `cell` | number | Cell size in px. |
| `palette` | string[] \| number | Brand colours (any CSS colours, at least two) or a count. With colours: `dither` levels become them darkest to lightest, `halftone`/`crosshatch` print the darkest as ink on the lightest as paper, `pixelate` snaps each cell to the nearest one. `riso` and `images` don't use colours. Default 2. |
| `sources` | `<img>` / `<video>` list | Tiles, for `'images'`. |

Does no work while off screen or in a hidden tab, and steps down resolution on devices that can't keep up. Without WebGL2 the original media shows, unchanged.

## License

MIT © 2026 [Olawale Balo](https://github.com/walebuilds)
