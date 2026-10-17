# Comice morph showcase

```sh
pnpm build
bun harness/acceptance/serve.ts
```

Open `http://localhost:8750/demo/morph/`.

Every morph transitions directly between its `from` and `to` silhouettes.
Every demo starts with Comice's native scroll driver: scroll down to morph and
back up to separate. There are 25 examples (most of the general ones leave `to` out, so they end in the media's own 16px-rounded frame), each with a finish tuned to look like
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
locally, with their open-font licenses in `../assets/fonts/`. Buttons use the
showcase’s green, `#00C65C`. Settings are kept per demo and
immediately reflected in its code. Reset restores that demo's default settings and shapes. Escape closes the inspector.

Morph geometry uses Comice core and morph; the Progress Dial also uses `@comice/type` for its melting counter. There are no additional movement
helpers, stage transforms, progress scrubbers or independent autoplay timelines.
The inspector's Pause videos control pauses media playback.

Only visible examples own a live WebGL context. Leaving a section pauses its
video and destroys its handle; returning creates a fresh instance. Hidden tabs
pause video playback. Failed loads and missing WebGL keep the real media.

All images, SVG silhouettes, fonts, footage, and soundtrack helpers live in
`demo/assets/`.
Video and audio stay ignored by Git, so another checkout must supply
`demo/assets/video/a.mp4`, `demo/assets/video/b.mp4` and optionally
`demo/assets/audio/fela.mp3`. The page imports the shared font stylesheet and soundtrack module directly.
No duplicated assets or soundtrack files are kept inside `demo/morph/`.

See `harness/morph/README.md` for visual regression checks.

The runtime avoids duplicate mounts while media is decoding, reports media load
timeouts, and restores viewport observation when returning through the browser's
back/forward cache. Geometry updates after resize commit together, and adaptive
render quality changes keep the same silhouette bake.

The final example, **Olawale Balo**, morphs `Olawale Balo` into `Design Engineer`
using two text masks, with playing video selected by default. The Image / Video
switch applies to every scene, using the A/B photographs in image mode.
The final scene has no heading or description and uses a plain dark background.
Geist loads before either text field is baked. Intermediate glyph contours are
smoothed while both endpoints stay sharp; the labels refit on smaller screens
and reverse when scrolling back.

Muted video starts when a scene mounts. If autoplay is blocked, a Play video
button provides a direct retry; the next user interaction also retries blocked
playback. Global pause and reduced-motion preferences continue to apply.

The shared Image / Video selector changes all 25 demos together. Image mode
alternates the 1920px photographs `demo/assets/images/a.jpg` and `b.jpg`.
Video mode restores each scene's footage.
