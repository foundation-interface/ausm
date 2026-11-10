import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    runtime: 'src/runtime.ts',
    clients: 'src/clients.ts',
    bridge: 'src/bridge.ts',
    'bridge-electron': 'src/bridge-electron.ts',
    'bridge-preload': 'src/bridge-preload.ts',
    'bridge-preload-api': 'src/bridge-preload-api.ts',
    'material-chat': 'src/material-chat.ts',
  },
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  treeshake: true,
  outDir: 'dist',
  external: [
    '@ausm/core',
    '@ausm/core/runtime',
    '@ausm/core/clients',
    '@ausm/bridge',
    '@ausm/bridge/electron',
    '@ausm/bridge/preload',
    '@ausm/bridge/preload-api',
    '@ausm/material-chat',
    'electron',
  ],
});
