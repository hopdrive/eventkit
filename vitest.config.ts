import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Coverage is gated in CI (testing-strategy.md §20): strict thresholds on the
    // runtime/ + core/ backbone (the low-churn, mission-critical code every consumer
    // leans on), looser global floors elsewhere. Tests, type-only fixtures, examples,
    // and declaration files are excluded from the measured surface.
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'text', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/__tests__/**',
        'src/**/__type-tests__/**',
        'src/**/__examples__/**',
        'src/**/*.d.ts',
      ],
      // Thresholds are a ratchet set just under current coverage: they fail CI on a
      // regression and rise as coverage grows. Bump them up when you raise coverage;
      // never lower them to make a red build pass.
      thresholds: {
        // Global floor — the broad surface (plugins, transports, flow).
        lines: 90,
        functions: 87,
        branches: 77,
        statements: 90,
        // Strict on the backbone: the runtime executor + core contracts.
        'src/runtime/**/*.ts': { lines: 95, functions: 86, branches: 84, statements: 95 },
        'src/core/**/*.ts': { lines: 90, functions: 88, branches: 74, statements: 90 },
      },
    },
  },
});
