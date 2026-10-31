import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const backend = `http://127.0.0.1:${process.env.PORT ?? 8787}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: backend },
      '/files': { target: backend },
    },
  },
});
