import { defineConfig } from 'vitest/config';

// These baseline tests inspect Worker source only. Keep deployment runtime
// compatibility in wrangler.toml; no local Workers runtime is needed here.
export default defineConfig({
  test: {
    include: ['tests/worker/**/*.test.js'],
    restoreMocks: true
  }
});
