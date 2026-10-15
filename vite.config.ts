import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './',
  plugins: [react()],
  define: { global: 'globalThis' },
  build: { chunkSizeWarningLimit: 4000 },
});
