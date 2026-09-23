# Contributing to comice

Thanks for taking a look. This is a pre-release monorepo — the state machine, all seven drivers, the WebGL2 pipeline, and fourteen plugins are built and tested, but nothing is published to npm yet. Contributions are welcome, with a few conventions worth knowing before you open a PR.

## Setup

```bash
pnpm install
pnpm build       # tsup build across all packages
pnpm typecheck    # tsc --noEmit across all packages
pnpm test         # bun test
pnpm test:coverage # bun test --coverage, enforces 100% line/function coverage
pnpm size          # size-limit check against the 10kB core budget
```

Requires Node ≥18 and pnpm ≥10. Tests run on [Bun](https://bun.sh)'s test runner.

## Conventions this repo actually enforces

- **100% line and function coverage, per file, enforced by `bunfig.toml`.** `pnpm test:coverage` fails the build if any source file drops below it. A PR that adds code without tests covering every branch won't pass CI.
- **Degrade, never disappear.** Every GL primitive and plugin must return `null`/no-op on failure (no WebGL2, a failed compile, a tainted canvas) rather than throwing — the fallback is always "show what the browser would have shown anyway," never a blank element.
- **Core stays under 10kB, gzip+brotli.** `pnpm size` checks this. Anything that isn't needed by every consumer belongs in a separate bundle entry (`comice/gl`, `comice/drivers/audio`) or a plugin package, not the main entry.
- **Plugins are peers.** No plugin imports another plugin's package — only `comice` core. If two plugins need the same logic, it belongs in core (see `packages/core/src/gl/mask.ts`'s `MASK_SAMPLE_GLSL` for the pattern: one shared chunk, every consumer splices it in).
- **States, not durations.** Interactive plugins react to `instance.on('*')` and the state machine's real events — no `setTimeout` standing in for "the animation is probably done by now."

## Commit style

Short imperative subject, `type: scope — summary`, real explanatory body when the change isn't self-evident from the diff. Look at recent history (`git log --oneline`) for the actual pattern used throughout this repo.

## Opening a PR

1. Branch off `main`.
2. Make sure `pnpm build && pnpm typecheck && pnpm test:coverage && pnpm size` all pass locally.
3. Open the PR against `main` with a description of what changed and why.

For anything nontrivial, opening an issue first to discuss the approach is appreciated — especially for new plugins, which should map to one of comice's five operations (merge, breakout, distribute, mask, recompose) per `README.md`'s own architecture section.
