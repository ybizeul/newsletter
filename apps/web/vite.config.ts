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
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          "vendor-react": ["react", "react-dom", "react-router-dom"],
          "vendor-mantine": ["@mantine/core", "@mantine/hooks", "@mantine/dates"],
          "vendor-tiptap": [
            "@tiptap/core",
            "@tiptap/react",
            "@tiptap/starter-kit",
            "@tiptap/extensions",
            "@tiptap/extension-font-family",
            "@tiptap/extension-highlight",
            "@tiptap/extension-horizontal-rule",
            "@tiptap/extension-image",
            "@tiptap/extension-link",
            "@tiptap/extension-list",
            "@tiptap/extension-subscript",
            "@tiptap/extension-superscript",
            "@tiptap/extension-table",
            "@tiptap/extension-table-cell",
            "@tiptap/extension-table-header",
            "@tiptap/extension-table-row",
            "@tiptap/extension-text-align",
            "@tiptap/extension-text-style",
            "@tiptap/extension-typography",
            "@tiptap/extension-underline",
          ],
        },
      },
    },
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
      },
      "/view": {
        target: "http://localhost:8080",
        headers: { "X-Forwarded-Proto": "https" }
      }
    }
  }
});
