import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "../api/internal/webui/dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("src/lib/tablerIconsBrowser.ts")) {
            return "tabler-icons-browser";
          }

          if (!id.includes("node_modules")) {
            return undefined;
          }

          if (id.includes("react-router-dom") || id.includes("react-dom") || id.includes("/react/")) {
            return "react";
          }

          if (id.includes("@uiw/react-md-editor") || id.includes("@uiw/react-markdown-preview")) {
            return "editor";
          }

          if (id.includes("@tiptap/")) {
            return "tiptap";
          }

          if (id.includes("@mantine/")) {
            return "mantine";
          }

          return "vendor";
        }
      }
    }
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8080",
        changeOrigin: true
      }
    }
  }
});
