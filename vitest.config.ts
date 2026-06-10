import { defineConfig } from 'vitest/config';

/**
 * Configuration Vitest.
 * Seuil de couverture aligné sur les standards BlackRabbIT : 80 % minimum sur les statements.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      // On mesure la couverture de la logique métier, pas du point d'entrée CLI ni des types.
      include: ['src/**/*.ts'],
      exclude: ['src/cli.ts', 'src/types/**', 'src/commands/install.ts'],
      thresholds: {
        statements: 80,
        branches: 75,
        functions: 80,
        lines: 80,
      },
    },
  },
});
