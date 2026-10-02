import { defineConfig } from 'tsup'

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/machine.ts',
    'src/scheduler.ts',
    'src/mapping.ts',
    'src/drivers/index.ts',
    'src/drivers/audio.ts',
    'src/gl/index.ts',
  ],
  format: ['esm', 'cjs'],
  dts: { compilerOptions: { composite: false, incremental: false } },
  clean: true,
  sourcemap: false,
  // Shared chunks, not one inlined copy per entry: with `splitting: false`
  // every entry (comice, comice/scheduler, comice/gl, comice/drivers)
  // bundled its OWN copy of scheduler.ts — four "shared" schedulers, four
  // rAF loops, and module state (the frame budget) that one entry wrote
  // and another never saw. Found when the budget never stepped down in a
  // real browser. tsup splits cjs too when this is set explicitly.
  splitting: true,
  treeshake: true,
})
