# Morph regression checks

Run from the repository root:

```sh
pnpm build
bun harness/acceptance/serve.ts       # localhost:8750 (leave running)
pnpm test:morph                     # Chromium + WebKit
```

The demo is at `/demo/morph/`. The regression page is at `/harness/morph/`.
`ACCEPTANCE_URL` overrides the server URL. You can run one engine with
`node harness/morph/run.mjs chromium` after building the test bundle.

The reference math is captured in `fixtures/prototype-reference.json`, extracted
from the retired prototype pages before removing the top-level legacy folder.
The snapshot contains only shader templates and mask producers, plus source
hashes for provenance; it has no page markup, media players or application setup.
It is evaluated without loading Three.js or GSAP. Tests compare the historical
examples at progress
0, .2, .5, .8, and 1. Both renderers use the same paused video frame/image,
resolution, cursor and velocity. Reference blending follows Three's transparent
NormalBlending; the archived renderer outputs premultiplied color. The historical engine lives in `legacy-engine/`, outside the published plugin. This regression protects the earlier port; it does not assert that arbitrary supplied shapes reproduce the prototypes’ per-piece movement.

Masks are also tested independently: the original legacy mask producers bake
RGBA bytes, core bakes its R8 field, and framebuffer readback compares their red
channels. Sharing a mask in the shader comparison cannot conceal a bake error.

Pass thresholds on 8-bit channels:

- Mean RGBA difference below .12; no more than 1% of pixels differ by over 3.
- Mean alpha difference below .01.
- Mean independently baked mask difference below 3. Core bakes an exact
  Euclidean distance field; legacy baked a two-pass chamfer approximation that
  is off by several percent over long distances, which showed as thin slits
  through a shape halfway through a morph. The exact field differs from the
  legacy bytes by about 1 to 2 levels on average, while the rendered frames
  above still match legacy within the strict limits.

These allow floating-point/alpha rounding across engines while detecting shape,
orientation, crop, progress-direction and texture differences. They verify the
renderer and mask producers; scroll inertia and timing are checked by interactive
smoke tests, rather than claimed to be byte-identical to GSAP's scrub clock.

The runner also opens the actual demo, checks contained scroll progress, ready
events, code snippets, overflow, bounded live canvas count, and teardown for six
representative cases. It also executes the code printed beneath those demos,
so the displayed snippets are checked against the actual public API. A transparent
SVG media regression also verifies source alpha and error-free GPU uploads. The
slab connection example has no legacy equivalent and is covered by those integration
checks and unit tests.

Additional real-GPU checks exercise the public `from`/`to` API: arbitrary SVG
documents and elements (including defs, transforms and holes), URLs, decoded
image inputs, asynchronous progress preservation, failure/abort cleanup, and
independent outline/refraction. A three-component SVG verifies that its center
gap is opaque while its top gap is still transparent early in the merge, and
both endpoints match their supplied silhouettes.

The supplied liquid-frame HTML is retained in `fixtures/liquid-frame.html`.
The midpoint-drop test extracts its GLSL template without loading its scripts.
It substitutes SVG distance fields for the hardcoded cards and uses Comice's
endpoint-union bounds and pixel antialiasing/crop, then compares the original drop growth, smooth union,
final-settle timing, and sheen over ten progress samples in both directions.
This checks the joining math; it does not claim the hardcoded card movement or
GSAP easing is identical to arbitrary SVG field interpolation. Additional checks
verify that the center neck widens before the top gap closes and that reverse
morphs retain the destination's holes. The bounds intentionally prevent the
original growing drops from bulging beyond supplied shapes; the original HTML
fixture remains unchanged. Browser checks cover that constraint with both join
styles and both directions, including outline and refraction.

`out/` contains screenshots and the JSON report. `build/` contains the generated
shader test bundle. Both directories are ignored by Git.

CSS support is checked against native browser clipping using transparent screenshots
and public-plugin GPU alpha readback. Run `node harness/morph/clip-path.mjs` for
18 geometry cases and ten behavior checks in Chromium, WebKit and iPhone emulation.
This covers responsive percentages, pixel coordinates, holes, rounded corners,
SVG/CSS mixing, separation, surface controls and captured starting frames.
Pointer checks verify a live wake, fading at rest, independent progress and unchanged
endpoints with directional glass lighting.
Unsupported syntax must fail rather than render an approximate replacement.

`node harness/morph/demo-shapes.mjs` executes the printed code for all 24 current
demos at five progress values, checking visible geometry, GPU errors, overflow
and teardown in Chromium, WebKit and iPhone emulation.

`node harness/morph/inspector.mjs` verifies the 256px floating settings panel,
contained scroll, native hover/click/drag drivers, slider keyboard control,
per-demo settings, SVG uploads, CSS input, copied playground code and teardown
in Chromium, WebKit and iPhone emulation. It also checks that inline progress
controls have been removed and the mobile layout has no horizontal overflow.
The inspector regression also verifies one shared Settings control, centered
stages, viewport-bottom code in the same sticky container, and code expansion.

Run one demo in isolation with `node harness/morph/demo-shapes.mjs chromium petals`
(the optional arguments select an engine and demo ID).

Production edge checks also verify 101 consecutive progress samples on a curved
silhouette, exact rest with zero GPU draws after a pointer wake, and a responsive
pixel-radius resize after the background fields commit. These run in Chromium,
WebKit and iPhone emulation as part of `clip-path.mjs`.

Run `node harness/morph/fast-scroll.mjs` to check rapid wheel reversals and
held scroll-speed extremes on the actual showcase in Chromium and WebKit.
Screenshots and progress/visibility traces are written to `out/fast-scroll/`.
The runner checks that no source media remains under a moving silhouette.
`MORPH_CAPTURE` can label a before/after capture (default: after).

The GPU edge regression now compares every endpoint alpha pixel at velocities
-20, -1, 1 and 20, checks all four corners near the endpoints, and verifies that
bending still changes the intermediate silhouette.
