import { defineConfig } from 'tsup';

export default defineConfig([
    // Library entry (in-process use of MaterialManager / FrameStore / extractors)
    {
        entry: ['index.ts'],
        format: ['cjs', 'esm'],
        dts: true,
        clean: true,
        sourcemap: true,
        target: 'node18',
        outDir: 'dist',
        // frame-reader.ts locates py/ via __dirname; shim it in the ESM build.
        shims: true,
    },
    // Service entry point (standalone process, spawned by @ausm/core's MaterialClient)
    {
        entry: { service: 'service.ts' },
        format: ['cjs'],
        dts: false,
        clean: false, // don't wipe dist from previous build step
        sourcemap: true,
        target: 'node18',
        outDir: 'dist',
        external: ['@ausm/device-macos-screen-stream'],
    },
]);
