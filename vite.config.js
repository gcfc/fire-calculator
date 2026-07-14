import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

// `npm run build` inlines the JS/CSS into one dist/index.html you can open
// straight off disk (file://) or email — no server, no asset paths.
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  server: { port: 5173, open: true },
  build: { outDir: "dist", emptyOutDir: true },
});
