import { defineConfig } from "vite";
import { testBenchAssets } from './test-bench-assets';
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react(), testBenchAssets()],
  server: {
    port: 5175,
    strictPort: true,
    proxy: {
      "/api/platform": {
        target: process.env.IVA_PLATFORM_TARGET || "http://127.0.0.1:4310",
        changeOrigin: false,
        ws: true,
      },
    },
  },
  preview: { port: 5175, strictPort: true },
  build: {
    outDir: "dist", emptyOutDir: true,
    // Font subsets must keep same-origin URLs under the portal's font-src policy.
    assetsInlineLimit: filePath => /\.(woff2?|ttf|otf)$/i.test(filePath) ? false : undefined,
  },
});
