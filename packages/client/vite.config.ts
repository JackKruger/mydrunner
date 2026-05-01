import { defineConfig } from 'vite';

export default defineConfig({
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
