# @comice/ascii

Media rebuilt from characters, live, on the GPU.

A plugin for [Comice](https://github.com/boastack/comice), a GPU interaction engine for images and video.

## Install

```bash
npm install comice @comice/ascii
```

## Use

Target: an `<img>` or `<video>`.

```js
import { comice, hover } from 'comice'
import { ascii } from '@comice/ascii'

comice('.hero img')
  .use(ascii({ cell: 8 }))
  .driver(hover())
```

## Options

| Option | Type | |
|---|---|---|
| `charset` | string | Glyphs ordered dark to light. Default `' .:-=+*#%@'`. |
| `cell` | number | Cell size in px. Default 10. |

Does no work while off screen or in a hidden tab, and steps down resolution on devices that can't keep up. Without WebGL2 the original media shows, unchanged.

## License

MIT © 2026 [Olawale Balo](https://github.com/walebuilds)
