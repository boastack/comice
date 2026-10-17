# @comice/layout

The page reacting to the media, rather than the media sitting inside the page.

A plugin for [Comice](https://github.com/boastack/comice), a GPU interaction engine for images and video.

## Install

```bash
npm install comice @comice/layout
```

## Use

Target: an `<img>` or `<video>` inside flowing text.

```js
import { comice } from 'comice'
import { layout } from '@comice/layout'

comice('.article img').use(layout({ mode: 'wrap', shape: 'ellipse' }))

// Crop to a portrait ratio, keeping the face in frame at every width
comice('.hero img').use(layout({ mode: 'crop', aspect: '4/5', focal: [0.6, 0.3] }))
```

## Options

| Option | Type | |
|---|---|---|
| `mode` | `'wrap'` \| `'avoid'` \| `'anchor'` \| `'crop'` | **Required.** `'crop'`: the media crops to `aspect`, keeping `focal` in frame as the box resizes. |
| `shape` | `'rect'` \| `'ellipse'` | Shape text wraps around. Default `'ellipse'`. |
| `float` | `'left'` \| `'right'` | Default `'left'`. |
| `margin` | number | Gap in px. Default 16. |
| `target`, `edge`, `offset` |  | For `'anchor'`: the element to pin, which edge, and the gap. |
| `aspect` | string \| number | For `'crop'`: `'4/5'`, `'16/9'` or a number. Default: the box's own shape. |
| `focal` | `[x, y]` | For `'crop'`: the point (0..1 of the image) kept in frame, centred when the image allows. Default `[0.5, 0.5]`. `'subject'` needs `@comice/vision` (not built yet). |

Uses CSS `shape-outside`, so the text stays real, selectable text.

## License

MIT © 2026 [Olawale Balo](https://github.com/walebuilds)
