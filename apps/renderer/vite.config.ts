import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const root = path.resolve(process.cwd(), "apps/renderer");

export default defineConfig({
  root,
  base: "./",
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: path.resolve(process.cwd(), "dist/renderer"),
    emptyOutDir: true,
  },
});