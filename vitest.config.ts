import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Server-half suites run in plain node. Browser-half suites opt into a DOM
    // environment with a `// @vitest-environment jsdom` docblock at the top of
    // the file, so node-only suites keep their fast startup.
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    },
  },
})
