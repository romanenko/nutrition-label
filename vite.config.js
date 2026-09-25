import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./extension/manifest.json" with { type: "json" };

export default defineConfig(({ command }) => ({
  root: fileURLToPath(new URL("./extension", import.meta.url)),
  plugins: [
    crx({
      manifest: {
        ...manifest,
        name: command === "serve" ? "Nutrition Label (Dev)" : manifest.name,
      },
    }),
  ],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    cors: {
      origin: [/^chrome-extension:\/\/[a-p]{32}$/],
    },
  },
  build: {
    outDir: fileURLToPath(
      new URL(command === "serve" ? "./dist/dev" : "./dist/release", import.meta.url),
    ),
    emptyOutDir: true,
  },
}));
