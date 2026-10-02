import { defineConfig } from "vite";
import solidPlugin from "vite-plugin-solid";

// Two entries, the panel module and the renderer module, built together so
// what they share (the vault list, Solid) is one chunk and one copy in the
// window: the file tree's menu and the panel read the same list. Built by the
// app's own `vite build` into dist/ here, which is not committed.
export default defineConfig({
  root: __dirname,
  plugins: [solidPlugin()],
  logLevel: "warn",
  build: {
    lib: {
      entry: { panel: "src/panel.tsx", renderer: "src/renderer.ts" },
      formats: ["es"],
      fileName: (_format, name) => `${name}.js`,
      cssFileName: "panel",
    },
    outDir: "dist",
    emptyOutDir: true,
    // Electron 33's Chromium.
    target: "chrome130",
  },
});
