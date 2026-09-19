# Security policy

## Reporting a vulnerability

Please do not disclose security vulnerabilities in a public issue. Use the repository's **Security → Report a vulnerability** flow. If private vulnerability reporting is unavailable, include a minimal reproduction, affected version, and impact assessment.

## Responsibility boundary

Comice puts media on the GPU and reacts to input — it is not a content sanitizer, an access-control layer, or a CDN. Applications remain responsible for:

- Only passing `comice()` elements the application already trusts to render (comice does not fetch or validate media on the caller's behalf).
- Any authentication, authorization, or rate limiting around what media a user can request the page to display.
- Cross-origin media: a `<video>`/`<audio>` element's own CORS configuration governs whether comice's drivers can read pixel/audio data from it (`drivers/audio.ts`'s `AnalyserNode`, and any future pixel-reading plugin) — comice does not relax or bypass this.

## GPU resource limits

Comice creates a WebGL context and GPU textures per instance. A page that creates unbounded `comice()` instances (e.g. one per row in an unpaginated list) can exhaust available WebGL contexts or GPU memory, which browsers handle by silently dropping the oldest context (`webglcontextlost`) rather than crashing the tab — but the visual result is broken rendering, not a security issue. Applications with a large or unbounded number of media elements should:

- Call `.destroy()` on any `comice()` instance no longer in the DOM, to release its GPU resources deterministically rather than waiting on garbage collection.
- Consider virtualization (only instantiate `comice()` for elements near the viewport) for large lists — the shared scheduler's visibility gating pauses rendering for off-screen instances, but does not release their GPU resources.

## The audio driver

`comice/drivers/audio` (`audio()`) reads frequency data from an `<audio>`/`<video>` element or an existing Web Audio `AudioNode` via an `AnalyserNode`. It is a **passive tap**, not a recorder or transport:

- It never calls `.play()`/`.pause()` on the source, never routes audio anywhere it wasn't already going, and never persists, transmits, or logs audio data — frequency bins are read into a reused typed array and discarded every frame.
- For a `<audio>`/`<video>` element specifically, connecting it to the Web Audio graph via `createMediaElementSource()` is a one-time, irreversible operation per element (a Web Audio platform constraint) — the driver caches the resulting node on the element itself so a second `audio()` instance pointed at the same element reuses it rather than throwing.
- A microphone or other live-capture source is **not** built into `audio()` — a caller who passes a `MediaStreamAudioSourceNode` sourced from `getUserMedia()` is responsible for that permission prompt and its own data-handling policy; comice's driver treats it identically to any other `AudioNode`.

## Crash isolation, not sandboxing

Comice's shared scheduler, event listeners, and mapping pipeline isolate exceptions thrown by one plugin, driver, or listener callback so they don't take down every other instance on the page (see `ROADMAP.md` for the specifics). This is a **reliability** measure, not a **security** boundary — a plugin or driver you `.use()`/`.driver()` still runs with the same privileges as any other code on the page. Only attach plugins and drivers from sources you trust, the same as any other JavaScript dependency.

## Supported versions

Comice is pre-1.0 and unpublished. Security fixes land on `main`; there is no long-term support policy yet.
