import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  // Declarations are emitted by tsgo (see the build script), not rolldown-plugin-dts,
  // which cannot drive the TypeScript 7 (native) compiler host used across this repo.
  dts: false,
  format: ['esm', 'cjs'],
  clean: true,
  platform: 'neutral',
})
