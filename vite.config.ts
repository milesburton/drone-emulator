import { defineConfig } from 'vitest/config';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig({
  base: './',
  plugins: [viteSingleFile()],
  build: { target: 'es2022' },
  test: {
    environment: 'node',
    // Long simulation sweeps run several times slower on CI runners under coverage.
    testTimeout: 60_000,
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/main.ts', 'src/render.ts', 'src/**/*.test.ts'],
    },
  },
});
