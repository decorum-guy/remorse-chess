import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync, existsSync, cpSync } from "node:fs";
import { fileURLToPath } from "node:url";

const shiftAssets = fileURLToPath(new URL("../../games/shift/public/shift-assets", import.meta.url));

export default defineConfig({
  plugins: [react(), {
    name: "shift-local-assets",
    configureServer(server) {
      server.middlewares.use("/shift-assets", (req, res, next) => {
        const path = decodeURIComponent((req.url || "/").split("?")[0]);
        if (path.includes("..")) { res.statusCode = 400; res.end(); return; }
        const file = shiftAssets + path;
        if (!existsSync(file)) { next(); return; }
        const ext = file.split(".").pop() || "";
        const mime: Record<string, string> = { glb: "model/gltf-binary", svg: "image/svg+xml", wav: "audio/wav", ttf: "font/ttf", woff2: "font/woff2", json: "application/json" };
        res.setHeader("Content-Type", mime[ext] || "application/octet-stream");
        res.end(readFileSync(file));
      });
    },
    closeBundle() {
      if (existsSync(shiftAssets)) cpSync(shiftAssets, fileURLToPath(new URL("./dist/shift-assets", import.meta.url)), { recursive: true });
    },
  }],
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
  build: { outDir: "dist", emptyOutDir: true },
});
