/// <reference types="vitest" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The Flask backend (app.py) listens on 127.0.0.1:3000.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://127.0.0.1:3000', '/results': 'http://127.0.0.1:3000' } },
  test: { environment: 'jsdom', globals: true, setupFiles: ['./src/test/setup.ts'] },
})
