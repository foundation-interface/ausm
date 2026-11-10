import { defineConfig } from 'tsup';

const phase = process.env.TSUP_PHASE;

const memoryServiceEntry = {
  'memory-service': 'src/memory/service.ts',
};

const baseEntries = {
  index: 'src/index.ts',
  ...memoryServiceEntry,
};

const runtimeEntries = {
  runtime: 'src/runtime/index.ts',
  clients: 'src/runtime/clients/index.ts',
};

const entry =
  phase === 'base' ? baseEntries :
  phase === 'runtime' ? runtimeEntries :
  { ...baseEntries, ...runtimeEntries };

export default defineConfig({
  entry,
  format: ['cjs', 'esm'],
  dts: true,
  clean: phase !== 'runtime',
  sourcemap: true,
  splitting: false,
  treeshake: true,
  outDir: 'dist',
  external: [
    '@ausm/core/clients',
    '@ausm/device-macos-text-selection',
    '@ausm/device-macos-screen-stream',
    '@ausm/device-macos-cursor-plus-plus',
    '@ausm/device-macos-screenshot-detector',
    '@ausm/device-macos-clipboard-monitor',
    '@ausm/device-macos-camera',
    '@ausm/device-macos-viewport-manager',
    '@ausm/device-macos-text-input',
    '@ausm/device-macos-material-manager',
    '@ausm/detector-pipeline',
    '@ausm/material-chat',
    'node-gyp-build',
    'better-sqlite3',
    'sqlite-vec',
    '@huggingface/transformers',
  ],
});
