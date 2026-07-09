import { defineConfig } from "vite";
import solidPlugin from "vite-plugin-solid";
import { version } from "./package.json";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  base: "./",
  // Expose the package version to the renderer (shown in the settings sidebar).
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  plugins: [solidPlugin()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
