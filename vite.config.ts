import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [
    react(),
  ],
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    target: "es2022",
    cssCodeSplit: true,
    reportCompressedSize: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/mermaid")) return "mermaid";
          if (id.includes("node_modules/katex")) return "katex";
          if (id.includes("node_modules/pdfjs-dist")) return "pdfjs";
          return undefined;
        },
      },
    },
  },
  optimizeDeps: {
    exclude: ["pdfjs-dist"],
  },
  worker: {
    format: "es",
  },
});
