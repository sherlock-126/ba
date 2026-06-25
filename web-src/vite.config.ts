import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// Build ra ../web (Fastify serve tĩnh thư mục này). Dev: proxy /api → server :3600.
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: ['icons/apple-touch-icon.png', 'icons/favicon-32.png'],
      manifest: {
        name: 'BA Code Assistant — Kiến Trẻ',
        short_name: 'BA Kiến Trẻ',
        description: 'Trợ lý AI hỏi-đáp logic source code ERP & Marketing cho BA.',
        lang: 'vi',
        dir: 'ltr',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        theme_color: '#1f6fd0',
        background_color: '#f4f7fc',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-192-maskable.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: '/icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Precache CHỈ vỏ nhẹ (html/css/font). KHÔNG precache JS — chunk D2 ~8MB sẽ do
        // runtimeCaching('/assets/') cache lúc tải đầu (tránh nuốt 8MB khi cài + tránh lỗi vượt cap).
        globPatterns: ['**/*.{css,html,woff2}'],
        navigateFallback: '/index.html',
        // KHÔNG để SW nuốt các route server (file public /f/, api, proxy /workspace) → để request đi tới server.
        navigateFallbackDenylist: [/^\/api/, /^\/f\//, /^\/workspace/],
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            // Chunk JS lớn (D2/react-flow) + wasm: dùng lại bản đã tải, ngầm cập nhật.
            urlPattern: ({ url }) => url.pathname.startsWith('/assets/') || url.pathname.endsWith('.wasm'),
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'app-assets', expiration: { maxEntries: 60, maxAgeSeconds: 60 * 60 * 24 * 30 } },
          },
          {
            urlPattern: ({ url }) => url.origin === 'https://fonts.googleapis.com' || url.origin === 'https://fonts.gstatic.com',
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'google-fonts', expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 365 } },
          },
        ],
      },
    }),
  ],
  base: '/',
  // D2 (dist/browser tự chứa wasm+worker) — đừng pre-bundle để worker blob hoạt động đúng.
  optimizeDeps: { exclude: ['@terrastruct/d2'] },
  build: { outDir: '../web', emptyOutDir: true, chunkSizeWarningLimit: 9000 },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3600', changeOrigin: true },
    },
  },
});
