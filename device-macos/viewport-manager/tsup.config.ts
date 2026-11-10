import { defineConfig } from 'tsup';

export default defineConfig({
    entry: ['index.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    clean: true,
    sourcemap: true,
    // Inject __dirname/import.meta.url shims: helper-binary lookup uses __dirname in both formats.
    shims: true,
    target: 'node18',
    outDir: 'dist',
    external: [],
});
