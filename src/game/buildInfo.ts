/** Build stamp values injected at build/dev-server start by Vite `define` (see vite.config.ts). */
export const APP_VERSION: string = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "0.0.0";
export const GIT_SHA: string = typeof __GIT_SHA__ !== "undefined" ? __GIT_SHA__ : "dev";
export const BUILD_TIME: string = typeof __BUILD_TIME__ !== "undefined" ? __BUILD_TIME__ : new Date().toISOString();

/** Human-readable last-updated date/time in the viewer's local timezone. */
export function buildDate(): string {
  try {
    return new Date(BUILD_TIME).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return BUILD_TIME;
  }
}

/** e.g. "v0.1.0 · a1b2c3d". */
export function versionLabel(): string {
  return `v${APP_VERSION} · ${GIT_SHA}`;
}
