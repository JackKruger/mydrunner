import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const __dirname = dirname(fileURLToPath(import.meta.url));

// On GitHub Pages, assets live at /<repo>/ unless a custom domain is set.
// Configurable via env so a custom-domain deploy can use base=/.
const base = process.env.VITE_BASE ?? '/';

// Build-time version string baked into the bundle. The deploy workflow
// sets APP_VERSION to "<commit-count>.<short-sha>" so the number ticks
// up monotonically with every push to main, and dev builds show "dev".
const appVersion = process.env.APP_VERSION ?? 'dev';

export default defineConfig({
  base,
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  server: {
    port: 5173,
    strictPort: false,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    // Explicit multi-page build: Vite otherwise keeps only index.html and
    // drops the two authoring tools from production deploys.
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
        editor: resolve(__dirname, 'editor.html'),
        assetEditor: resolve(__dirname, 'asset-editor.html'),
      },
    },
  },
  // Rapier ships ESM + WASM. Vite handles WASM via ?init or default fetch;
  // @dimforge/rapier3d-compat bundles WASM as base64 inside the JS so it
  // works without extra config.
  optimizeDeps: {
    exclude: ['@dimforge/rapier3d-compat'],
  },
  // Client unit tests cover the DOM-facing glue (input handling, key
  // routing) that has no server-side equivalent, so they need a document.
  // Three.js / WebGL modules stay out of scope here - those are covered by
  // the Playwright suite against a real browser.
  test: {
    environment: 'jsdom',
    include: ['src/**/__tests__/**/*.test.ts'],
  },
});
