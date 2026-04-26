import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const APP_VERSION = '1.1.33';

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      '/api': {
        target: 'http://localhost:8002',
        changeOrigin: true,
        ws: true,
      },
    },
  },
})
