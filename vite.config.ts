import { build, defineConfig, type Plugin } from "vite";
import solidPlugin from "vite-plugin-solid";
import fs from "node:fs";
import path from "node:path";
import { version } from "./package.json";

// The built-in plugins (plugins/<id>/) are built with the app: every `vite
// build`, after the app's own bundle, builds each one that has a vite.config.ts
// into its own dist/. They are separate builds on purpose: a built-in plugin is
// loaded exactly the way an external one is, which is what keeps the plugin
// contract honest.
function bundledPlugins(): Plugin {
  return {
    name: "specterm-bundled-plugins",
    apply: "build",
    async closeBundle() {
      const root = path.resolve(__dirname, "plugins");
      for (const id of fs.existsSync(root) ? fs.readdirSync(root) : []) {
        const configFile = path.join(root, id, "vite.config.ts");
        if (fs.existsSync(configFile)) await build({ configFile });
      }
    },
  };
}

export default defineConfig(async () => ({
  base: "./",
  // Expose the package version to the renderer (shown in the settings sidebar).
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  plugins: [solidPlugin(), bundledPlugins()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
}));
