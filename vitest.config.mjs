import { resolve } from 'path'
import { fileURLToPath } from 'url'
import { defineConfig } from 'vitest/config'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['packages/aiCore/setupVitest.ts'],
    include: [
      'src/main/**/*.{test,spec}.{ts,tsx}',
      'src/main/**/__tests__/**/*.{test,spec}.{ts,tsx}',
      'scripts/**/*.{test,spec}.{ts,tsx}',
      'scripts/**/__tests__/**/*.{test,spec}.{ts,tsx}'
    ],
    exclude: ['**/node_modules/**', '**/dist/**', '**/out/**', '**/build/**'],
    testTimeout: 20000,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true
      }
    }
  },
  resolve: {
    alias: {
      '@main': resolve(__dirname, 'src/main'),
      '@types': resolve(__dirname, 'src/renderer/src/types'),
      '@shared': resolve(__dirname, 'packages/shared'),
      '@logger': resolve(__dirname, 'src/main/services/LoggerService'),
      '@mcp-trace/trace-core': resolve(__dirname, 'packages/mcp-trace/trace-core'),
      '@mcp-trace/trace-node': resolve(__dirname, 'packages/mcp-trace/trace-node')
    }
  },
  esbuild: {
    target: 'node18'
  }
})