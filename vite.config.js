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
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (id.includes('pdfjs-dist')) return 'vendor-pdfjs';
          if (id.includes('pdf-lib')) return 'vendor-pdflib';
          if (id.includes('@tiptap')) return 'vendor-editor';
          if (id.includes('react-router-dom')) return 'vendor-router';
          if (id.includes('@react-oauth')) return 'vendor-auth';
          if (id.includes('react') || id.includes('scheduler')) return 'vendor-react';
          return 'vendor-misc';
        },
      },
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    // ✅ 这一段必须加上，否则本地无法连接后端
    proxy: proxyConfig
  },
  // vite preview 不会继承 dev server 的代理，单独配置一份，避免预览/分享链接时 API 报网络错误
  preview: {
    proxy: proxyConfig
  }
});
