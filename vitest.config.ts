import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    // Agent worktrees and the Next.js app keep their own copies and tests.
    exclude: [...configDefaults.exclude, '.claude/**', 'frontend/**'],
  },
});
