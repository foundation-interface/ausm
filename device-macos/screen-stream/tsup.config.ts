import { defineConfig } from 'tsup';

export default defineConfig({
    entry: ['index.ts', 'src/helper-client.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    sourcemap: true,
    clean: true,
});
