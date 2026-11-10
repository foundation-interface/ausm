import { defineConfig } from 'tsup';

export default defineConfig({
    entry: ['index.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    clean: true,
    sourcemap: true,
    target: 'node18',
    outDir: 'dist',
    external: ['@google/genai', 'sharp'],
});
