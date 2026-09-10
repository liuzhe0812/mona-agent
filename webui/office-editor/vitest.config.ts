import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { officeAliases } from './mona/build-aliases'

const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  root,
  plugins: [react()],
  resolve: {
    alias: officeAliases(root),
  },
  esbuild: {
    tsconfigRaw: JSON.stringify({
      compilerOptions: {
        jsx: 'automatic',
        target: 'ES2022',
      },
    }),
  },
  test: {
    environment: 'node',
    include: ['mona/**/*.test.ts'],
  },
})
