import { defineConfig } from "vite";

// Static-site config. `base: "./"` keeps asset paths relative so the build can be
// served from any subpath (e.g. GitHub Pages project pages).
export default defineConfig({
  base: "./",
  server: {
    host: true, // expose on LAN so a phone can connect to the dev server
    port: 5173,
  },
  build: {
    target: "es2020",
    outDir: "dist",
  },
});
