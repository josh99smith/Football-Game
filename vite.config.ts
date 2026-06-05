import { defineConfig } from "vite";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };
function gitShortSha(): string {
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "dev";
  }
}

// Static-site config. `base: "./"` keeps asset paths relative so the build can be
// served from any subpath (e.g. GitHub Pages project pages).
export default defineConfig({
  base: "./",
  // Build-time stamp surfaced on the main menu so each push is identifiable.
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __GIT_SHA__: JSON.stringify(gitShortSha()),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
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
