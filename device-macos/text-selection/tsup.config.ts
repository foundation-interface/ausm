import { defineConfig } from 'tsup';

export default defineConfig({
    entry: ['index.ts', 'ausm-adapter.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    sourcemap: true,
    clean: true,
    external: ['node-gyp-build'],
    platform: 'node',
    target: 'node18',
    // index.ts uses __dirname/__filename to locate the native addon; shim
    // them in the ESM build.
    shims: true,
});
