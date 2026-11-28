import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    host: '127.0.0.1', port: 5284, strictPort: true,
    proxy: {
      '/api/realtime': { target: 'http://127.0.0.1:4284', changeOrigin: false },
      '/health/realtime': { target: 'http://127.0.0.1:4284', changeOrigin: false },
      '/api': { target: 'http://127.0.0.1:4285', changeOrigin: false },
      '/ws/realtime': { target: 'ws://127.0.0.1:4284', ws: true, changeOrigin: false },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1100 },
});
