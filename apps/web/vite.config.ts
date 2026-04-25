import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import mkcert from 'vite-plugin-mkcert'
import path from "path";

export default defineConfig({
  plugins: [react(), mkcert()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src")
    }
  },
  build: {
    outDir: "../api/internal/webui/dist",
    emptyOutDir: true
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    https: {},
    proxy: {
      "/callback": {
        target: "http://localhost:8080",
        headers: { "X-Forwarded-Proto": "https" }
      },
      "/api": {
        target: "http://localhost:8080",
        headers: { "X-Forwarded-Proto": "https" }
      }
    }
  }
});
