import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    // Recognition requests go to the local server so the API key never reaches the browser.
    proxy: {
      '/api': 'http://localhost:8787',
    },
  },
  build: {
    // PDF.js and the PowerPoint renderer are over 1 MB, but each loads only when a file of that
    // kind is first opened, so the size doesn't slow the app's first load.
    chunkSizeWarningLimit: 1500,
  },
});
