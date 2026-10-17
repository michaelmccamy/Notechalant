import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    // Recognition requests go to the local server so the API key never reaches the browser.
    proxy: {
      '/api': 'http://localhost:8787',
    },
  },
});
