# @comice/dissolve

Media moving from A to B — transitions over two resident textures.

A plugin for [Comice](https://github.com/boastack/comice), a GPU interaction engine for images and video.

## Install

```bash
npm install comice @comice/dissolve
```

## Use

Target: a container element (the stage).

```js
import { comice, scroll } from 'comice'
import { dissolve } from '@comice/dissolve'

const from = document.querySelector('#before')
const to = document.querySelector('#after')

comice('#stage')
  .use(dissolve({ transition: 'noise', from, to }))
  .driver(scroll())

// A gallery that melts through every image as you scroll
comice('#gallery').use(dissolve({ transition: 'displace', to: images, map: '/wave.png' })).driver(scroll())
```

## Options

| Option | Type | |
|---|---|---|
| `from`, `to` | `<img>` \| `<video>` | The two media. `to` may be an array for a **sequence** (then `from` is optional): progress runs through every one in order. |
| `transition` | `'crossfade'` `'displace'` `'wipe'` `'zoomBlur'` `'pixelBridge'` `'ink'` `'flip'` `'glitch'` `'noise'` `'liquid'` `'mask'` `'dissolve'` | Default `'crossfade'`. |
| `noise` | `{ scale, intensity, direction, threshold, softness, seed }` | Shapes the noise-driven transitions; `direction` (degrees) also steers `'wipe'`. |
| `map` | string | URL of a displacement texture for `'displace'` (red/green push x/y). Without one, displace uses noise. |
| `mask` | shape \| text \| `<img>` \| `<video>` | For `'mask'`: `{ type: 'shape', path }`, `{ type: 'text', text }`, or media read by brightness. |

Does no work while off screen or in a hidden tab. With `prefers-reduced-motion` it cuts between the two media instead of transitioning. Without WebGL2 the stage is left as it is.

## License

MIT © 2026 [Olawale Balo](https://github.com/walebuilds)
