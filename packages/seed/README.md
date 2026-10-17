# @comice/seed

Everything before media is ready — placeholders, priority, decoding, art direction.

A plugin for [Comice](https://github.com/boastack/comice), a GPU interaction engine for images and video.

## Install

```bash
npm install comice @comice/seed
```

## Use

Target: an `<img>` or `<video>`.

```js
import { comice } from 'comice'
import { seed } from '@comice/seed'

comice('.card img').use(seed({ placeholder: 'thumbhash', hash: 'YOUR_THUMBHASH', priority: true }))
```

## Options

| Option | Type | |
|---|---|---|
| `placeholder` | `'thumbhash'` \| `'blurhash'` \| `'lqip'` | Default `'thumbhash'`. |
| `hash` | string | The ThumbHash or BlurHash string. |
| `lqip` | string | A tiny data-URI image, for `'lqip'`. |
| `focal` | `[x, y]` | Focal point, 0..1. |
| `priority` | boolean | Load eagerly with high fetch priority. |

Changes nothing about the media itself; only what shows before it is ready.

## License

MIT © 2026 [Olawale Balo](https://github.com/walebuilds)
