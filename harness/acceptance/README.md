# Acceptance: the spec's own examples, in real browsers

Every runnable code example in `comice.html`, run as written, each in its own page, then checked in real engines and on emulated phones.

```bash
pnpm build
bun harness/acceptance/serve.ts          # http://localhost:8750/harness/acceptance/
node harness/acceptance/run.mjs          # all projects; or: chromium webkit firefox iphone pixel
node harness/acceptance/run.mjs webkit --only=7,8
```

- `examples.js`: one entry per example. Each `run()` opens with a `// given:` line supplying what the spec's snippet assumes exists (an image, a callback); everything after it is the spec's code, unchanged. The page shows `run`'s own source, so what you read is what ran.
- `comice-tap.js` stands in for `comice` in the import map: core's exports unchanged, plus a record of every handle and lifecycle event, so the runner can drive an example without editing it.
- `serve.ts` serves the repo and the root-relative assets the examples name (`/founder.jpg`, `/wave.png`).
- `run.mjs` checks each example does what its card says (hover or tap, scroll, keyboard, swipe, text changes), with no errors, and screenshots it to `out/`. `iphone` and `pixel` emulate phones with touch; in Chromium a swipe is real touch input, in WebKit a pointer drag.
- `assets/` is generated (portrait, landscape, city, displacement map, a logo on transparency, a bass track).

Not run: blocks 2 (a type and a GLSL signature), 3 and 12 (vision, spatial), 15 (React), 16 (Studio) and 17 (the repository layout).

Two examples are adapted, and say so in their `given:` line: block 4's path is cut short in the spec (`'M12 2L2 7…'`), so it uses that icon's closed first layer; block 14 stacks three GPU plugins on one element, which "one GPU effect per element" refuses, so each gets its own element.
