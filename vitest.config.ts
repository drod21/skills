import { defineConfig } from 'vitest/config'

// Most board tests spawn the CLI as a child process, so a loaded host needs more than the 5s default.
export default defineConfig({
  test: {
    include: ['scripts/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
