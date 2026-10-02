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
```

## Options

| Option | Type | |
|---|---|---|
| `from`, `to` | `<img>` \| `<video>` | **Required.** The two media to move between. |
| `transition` | `'crossfade'` \| `'noise'` \| `'liquid'` | Default `'crossfade'`. |
| `noise` | `{ scale, intensity, softness }` | Shape of the noise-driven edge. |

Does no work while off screen or in a hidden tab. With `prefers-reduced-motion` it cuts between the two media instead of transitioning. Without WebGL2 the stage is left as it is.

## License

MIT © Olawale Balo
