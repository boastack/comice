import { defineConfig } from 'tsup'

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/machine.ts',
    'src/scheduler.ts',
    'src/mapping.ts',
    'src/drivers/index.ts',
    'src/drivers/audio.ts',
  ],
  format: ['esm', 'cjs'],
  dts: { compilerOptions: { composite: false, incremental: false } },
  clean: true,
  sourcemap: false,
  splitting: false,
  treeshake: true,
})
