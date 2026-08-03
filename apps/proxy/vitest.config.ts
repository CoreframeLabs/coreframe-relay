import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    // Plain node, not the workers pool: these tests drive `app.request()`, Hono's own
    // test entry point, which needs no Workers runtime. The workers pool is worth its
    // setup cost once KV and real bindings are involved ([RELAY-4]).
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
