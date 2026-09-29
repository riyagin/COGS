import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  // The Android app loads its UI from the device, so it must know where the hosted API lives
  if (mode === 'android' && !loadEnv(mode, process.cwd()).VITE_API_URL) {
    throw new Error('Set VITE_API_URL in frontend/.env.android to the deployed site, e.g. https://your-app.vercel.app')
  }

  return {
    plugins: [react()],
    server: {
      proxy: {
        '/api': 'http://localhost:3001',
      },
    },
  }
})
