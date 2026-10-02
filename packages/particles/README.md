# @comice/particles

Media as a cloud of points, and media broken into tiles.

A plugin for [Comice](https://github.com/boastack/comice), a GPU interaction engine for images and video.

## Install

```bash
npm install comice @comice/particles
```

## Use

Target: a container element.

```js
import { comice, scroll } from 'comice'
import { particles } from '@comice/particles'

comice('#cloud')
  .use(particles({ from: document.querySelector('#portrait'), to: { text: 'HELLO' } }))
  .driver(scroll())
```

## Options

| Option | Type | |
|---|---|---|
| `from` | `<img>` \| `<video>` \| `{ text }` | **Required.** What the points start as. |
| `to` | same | What they become. |
| `mode` | `'cloud'` \| `'shatter'` | Points or tiles. Default `'cloud'`. |
| `count` | number | Number of points. |
| `motion` | `{ fluid, noise }` | Drift while in flight. |

Does no work while off screen or in a hidden tab. With `prefers-reduced-motion` the points jump to their end state and stop drifting. Without WebGL2 the container is left as it is.

## License

MIT © Olawale Balo
