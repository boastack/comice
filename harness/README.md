# harness/

A real-browser verification page, separate from the `bun test` suite. Every unit test in `test/` runs against `test/fake-webgl2.ts` — a hand-written stand-in for `WebGL2RenderingContext` (happy-dom, this repo's DOM test environment, has no real WebGL2 or 2D canvas implementation at all). That fake is good at proving call-sequence logic (compile → link → draw, degrade-on-failure paths) but it is not a GLSL compiler, and it cannot catch everything a real browser's own shader compiler and driver can.

This harness closes that gap. It loads every plugin that owns real GLSL — `morph`, `dissolve`, `distort`, `color`, `mosaic`, `ascii`, `particles`, `aura` — through comice's actual public API (`comice(target).use(plugin(options))`, no test doubles) against real canvas-generated media, in whatever real browser you point at it.

## Running it

```bash
pnpm build       # dist/ must be current — the harness imports built output, not src/
pnpm harness     # serves the repo root on :8743
```

Then open `http://localhost:8743/harness/index.html`. Every card shows its own compile/link status; a failing card prints the real browser compiler's own diagnostic text (not just "it threw").

## What it found, already fixed

`particles`'s `cloud` mode declared `a_baseVertex` in its shared vertex-shader header but never read it in `cloud`'s own `main()` (only `shatter`'s does) — a real, spec-compliant WebGL2 compiler is free to optimize an unused `in` attribute away entirely, which makes `getAttribLocation()` return `-1` and made the following `enableVertexAttribArray`/`vertexAttribPointer` calls throw `INVALID_VALUE`. The fake GL context in `test/fake-webgl2.ts` always returned `0` for every attribute lookup, so no unit test could ever have caught this — it was only found by running this harness against a real Chromium build. Both the shader fix (a `!== -1` guard) and the fake itself (now tracking real shader source and returning `-1` for a genuinely-unused attribute) are fixed — see `packages/particles/src/shader.ts` and `test/fake-webgl2.ts`'s own comments for the full story.

## What it's not

- Not a build step, not part of `pnpm test`. It's a manual verification tool — run it after any shader change, before a release, or whenever `gl/noise.ts`'s "no GLSL compiler in this environment" limitation (see `ROADMAP.md`) needs closing for a specific plugin.
- Not a visual regression suite — it reports compile/link success, not "does this look right." Confirming actual rendered output still needs eyes on the page.
- 25 simultaneous full-effect instances on one page will trip a real browser's "too many active WebGL contexts" limit — that's the harness being denser than any real page would be, not a bug in `comice` (each plugin instance correctly gets its own context per `createGLContext()`'s own per-element caching).
- `harness/media.js` generates all test media in-browser via canvas drawing (gradients, shapes, a captured-canvas synthetic `<video>`) — no external image/video files to download or keep in sync, matching the project's own zero-dependency approach.
