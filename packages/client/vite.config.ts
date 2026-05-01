import { defineConfig } from 'vite';

// On GitHub Pages, assets live at /<repo>/ unless a custom domain is set.
// Configurable via env so a custom-domain deploy can use base=/.
const base = process.env.VITE_BASE ?? '/';

export default defineConfig({
  base,
  server: {
    port: 5173,
    strictPort: false,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  // Rapier ships ESM + WASM. Vite handles WASM via ?init or default fetch;
  // @dimforge/rapier3d-compat bundles WASM as base64 inside the JS so it
  // works without extra config.
  optimizeDeps: {
    exclude: ['@dimforge/rapier3d-compat'],
  },
});
