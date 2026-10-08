import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'

const here = p => fileURLToPath(new URL(p, import.meta.url))

// The renderer reuses sign-in, the API client, styles and UI pieces from ../frontend/src.
// Those files import react from wherever they sit, so dedupe pins one copy (ours).
export default defineConfig(({ command }) => ({
  base: './', // loaded from file:// when packaged
  plugins: [react(), command === 'build' && csp()],
  resolve: {
    dedupe: ['react', 'react-dom'],
    // api.js lazily imports Capacitor for Android downloads; the desktop is never native
    alias: Object.fromEntries(['core', 'filesystem', 'share'].map(p => [`@capacitor/${p}`, here('./src/lib/capacitor-stub.js')])),
  },
  server: {
    port: 5174,
    strictPort: true,
    fs: { allow: [here('..')] },
    proxy: { '/api': 'http://localhost:3001' },
  },
}))

// Content-Security-Policy for the packaged app only (the dev server injects inline scripts)
function csp() {
  return {
    name: 'csp',
    transformIndexHtml: () => [{
      tag: 'meta',
      attrs: {
        'http-equiv': 'Content-Security-Policy',
        content: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https:",
      },
      injectTo: 'head-prepend',
    }],
  }
}
