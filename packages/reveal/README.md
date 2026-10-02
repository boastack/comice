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

## Options

| Option | Type | |
|---|---|---|
| `effect` | `'mask'` `'wipe'` `'scale'` `'blur'` `'blinds'` `'slats'` `'curtain'` `'expand'` | How the element enters. Default `'mask'` when a `mask` is given, otherwise `'scale'`. |
| `mask` | cursor \| shape \| text \| `<img>` \| `<video>` | For `'mask'`: `{ type: 'cursor', radius, softness }`, `{ type: 'shape', path }`, `{ type: 'text', text }`, or another image/video read by brightness. Needs an `<img>`/`<video>` target. `'subject'`/`'depth'` need `@comice/vision` (not built yet). |
| `stagger` | object | Offsets for several elements entering together. |
| `waitForDecode` | boolean | Never reveal a blank frame. Default `true`. |

With `prefers-reduced-motion` the element appears in its end state instead of animating in.

## License

MIT © Olawale Balo
