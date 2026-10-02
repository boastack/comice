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

## Options

| Option | Type | |
|---|---|---|
| `effect` | `'wipe'` `'scale'` `'blur'` `'blinds'` `'slats'` `'curtain'` `'expand'` | How the element enters. |
| `stagger` | object | Offsets for several elements entering together. |
| `waitForDecode` | boolean | Never reveal a blank frame. Default `true`. |

With `prefers-reduced-motion` the element appears in its end state instead of animating in.

## License

MIT © Olawale Balo
