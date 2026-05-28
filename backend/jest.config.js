'use strict';

/**
 * Jest configuration for FinTrace NCRP backend.
 *
 * Coverage threshold is 70% across the four standard metrics — the spec's bar
 * for a Phase 8 release. The test runner discovers files under
 * `src/__tests__/**` so both unit specs (src/__tests__/*.test.js) and the
 * integration suite (src/__tests__/api/*.test.js) are picked up by a single
 * `npm test` invocation.
 */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/__tests__/**/*.test.js'],
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/db/seed.js',
    '!src/__tests__/**',
  ],
  coverageDirectory: 'coverage',
  coverageThreshold: {
    global: {
      branches: 70,
      functions: 70,
      lines: 70,
      statements: 70,
    },
  },
  // Integration tests open SQLite + the analysis pipeline; allow generous time.
  testTimeout: 20000,
  // Force serial execution so two integration tests don't race on the
  // in-memory DB or the shared uploads directory.
  maxWorkers: 1,
  verbose: false,
  clearMocks: true,
};
