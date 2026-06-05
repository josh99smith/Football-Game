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
    // Three.js is a single ~500kb chunk; that's expected for a 3D game.
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      // Multi-page: the game (index.html), the physics sandbox (motion.html), and the
      // animation+physics hybrid prototype (hybrid.html).
      input: { main: "index.html", motion: "motion.html", hybrid: "hybrid.html" },
    },
  },
});
