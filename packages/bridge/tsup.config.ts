import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'electron-bridge': 'src/electron-bridge.ts',
    preload: 'src/preload.ts',
    'preload-api': 'src/preload-api.ts',
  },
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  treeshake: true,
  outDir: 'dist',
  external: ['electron', '@ausm/core', '@ausm/core/runtime', '@ausm/core/clients'],
});
