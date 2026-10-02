import { defineConfig } from "vite";
import solidPlugin from "vite-plugin-solid";

// The panel module and its stylesheet, the two files specterm-plugin.json
// points at. Built by the app's own `vite build` (see bundledPlugins in the
// root vite.config.ts), into dist/ here, which is not committed. The same
// shape as an external plugin's build: it brings its own Solid.
export default defineConfig({
  root: __dirname,
  plugins: [solidPlugin()],
  logLevel: "warn",
  build: {
    lib: {
      entry: "src/panel.tsx",
      formats: ["es"],
      fileName: () => "panel.js",
      cssFileName: "panel",
    },
    outDir: "dist",
    emptyOutDir: true,
    // Electron 33's Chromium.
    target: "chrome130",
  },
});
