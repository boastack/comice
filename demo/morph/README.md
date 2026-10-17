# Comice morph showcase

```sh
pnpm build
bun harness/acceptance/serve.ts
```

Open `http://localhost:8750/demo/morph/`.

Every morph transitions directly between its `from` and `to` silhouettes.
Every demo starts with Comice's native scroll driver: scroll down to morph and
back up to separate. There are 24 examples (most of the general ones leave `to` out, so they end in the media's own 16px-rounded frame), each with a finish tuned to look like
glass and liquid: a soft edge sheen, light refraction and a gentle wake behind
the cursor. Each is a scene on a sticky stage; rectangles keep a wide aspect
ratio and narrow screens use square stages.

Toolbar, top right: the code button opens a card with the code for the demo on
screen, with syntax colours and a copy button; Settings opens a floating 256px
inspector for the same demo. Only one is open at a time, and Escape closes it.
The speaker button, bottom left, plays the shared Fela track. It starts on the
first scroll, wheel, touch or key press, as browsers only allow sound then.
The track lives in `demo/assets/audio/`, which is not published; without it
the button hides itself.

Settings > Shapes holds each demo's From and To: SVG markup, a URL or a CSS
clip-path, with an upload for each. Apply shapes loads them; an empty From
captures the media's frame. Reset demo restores every setting and both shapes.
Example geometry lives in ordinary assets; no shapes are built into the plugin.
SVG masks retain their supplied silhouette and aspect-ratio behaviour.
Choose scroll, hover, click, drag or audio (the soundtrack's energy drives the shape); adjust direction, liquid, joining, outline,
glass, pointer interaction and raster quality. Slider values are also editable
numbers, and sliders support keyboard arrows. Geist and Geist Mono are served
locally, with their open-font licenses in `assets/fonts/`. Buttons use the
showcase’s green, `#00C65C`. Settings are kept per demo and
immediately reflected in its code. Reset restores that demo's default settings and shapes. Escape closes the inspector.

Morph geometry uses Comice core and morph; the Progress Dial also uses `@comice/type` for its melting counter. There are no additional movement
helpers, stage transforms, progress scrubbers or independent autoplay timelines.
The inspector's Pause videos control pauses media playback.

Only visible examples own a live WebGL context. Leaving a section pauses its
video and destroys its handle; returning creates a fresh instance. Hidden tabs
pause video playback. Failed loads and missing WebGL keep the real media.

Shared footage, soundtrack and original SVG images live in `demo/assets/`.
Video and audio stay ignored by Git, so another checkout must supply
`demo/assets/video/bg.mp4`, `demo/assets/video/canvas.mp4` and optionally
`demo/assets/audio/fela.mp3`. Morph-specific shapes and fonts stay in
`demo/morph/assets/`. No top-level legacy directory is required.

See `harness/morph/README.md` for visual regression checks.

The runtime avoids duplicate mounts while media is decoding, reports media load
timeouts, and restores viewport observation when returning through the browser's
back/forward cache. Geometry updates after resize commit together, and adaptive
render quality changes keep the same silhouette bake.
