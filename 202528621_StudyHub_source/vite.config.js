import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const proxyConfig = {
  '/api': {
    target: 'http://127.0.0.1:5001',
    changeOrigin: true,
    secure: false
  },
  '/uploads': {
    target: 'http://127.0.0.1:5001',
    changeOrigin: true,
    secure: false
  }
};

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    // Keep local API and upload requests proxied to the Flask backend.
    proxy: proxyConfig
  },
  // vite preview does not inherit the dev server proxy, so configure it separately.
  preview: {
    proxy: proxyConfig
  }
});
