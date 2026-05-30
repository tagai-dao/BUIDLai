import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "public",
    emptyOutDir: false,
    target: "es2022",
    rollupOptions: {
      input: "src/privy/main.jsx",
      output: {
        entryFileNames: "privy-adapter.js",
        chunkFileNames: "privy-adapter-[hash].js",
        assetFileNames: "privy-adapter-[hash][extname]"
      }
    }
  }
});
