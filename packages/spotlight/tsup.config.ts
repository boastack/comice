import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: { compilerOptions: { composite: false, incremental: false } },
  clean: true,
  sourcemap: false,
  splitting: false,
  treeshake: true,
  external: ['comice'],
})
