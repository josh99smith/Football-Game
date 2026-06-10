import "./styles.css";
import { GameApp } from "./engine/Game";
import { MenuState } from "./game/states/MenuState";

const canvas = document.getElementById("game") as HTMLCanvasElement | null;
const canvas3d = document.getElementById("game3d") as HTMLCanvasElement | null;
if (!canvas || !canvas3d) throw new Error("missing game canvases");

const app = new GameApp(canvas, canvas3d);
app.start(new MenuState(app));

// Reclaim the browser URL/status bar on phones: request fullscreen on the first touch (browsers
// require a user gesture). Best-effort — ignored where unsupported/blocked (e.g. iOS Safari).
if (window.matchMedia("(pointer: coarse)").matches) {
  window.addEventListener(
    "pointerdown",
    () => { document.documentElement.requestFullscreen?.().catch(() => {}); },
    { once: true },
  );
}

// Dev-only handle for headless/scripted testing (stripped from production builds).
if (import.meta.env.DEV) {
  (window as unknown as { __app: GameApp }).__app = app;
  // Expose special-teams states so scripted tests can jump straight into a kick / decision.
  void Promise.all([
    import("./game/states/SpecialTeamsState"),
    import("./game/states/FourthDownState"),
  ]).then(([st, fd]) => {
    (window as unknown as { __states: unknown }).__states = {
      SpecialTeamsState: st.SpecialTeamsState,
      FourthDownState: fd.FourthDownState,
    };
  });
}

// Opt-in load diagnostic for remote debugging (e.g. on a phone): add #diag to the URL. Shows the
// model/clip load state + last error in a corner so a "models load but won't animate" report can be
// pinned down without guesswork. Off (and zero-cost) for normal play.
if (/(^|[#?&])diag\b/.test(location.hash + location.search)) {
  const el = document.createElement("div");
  el.style.cssText =
    "position:fixed;left:6px;bottom:6px;z-index:9999;font:11px/1.35 monospace;color:#0f0;" +
    "background:rgba(0,0,0,.72);padding:6px 8px;border-radius:6px;pointer-events:none;white-space:pre;max-width:60vw";
  document.body.appendChild(el);
  const gl = canvas3d.getContext("webgl2") || canvas3d.getContext("webgl");
  setInterval(() => {
    const ci = app.scene3d.charInfo;
    el.textContent =
      `WebGL: ${gl ? "ok" : "MISSING"}\n` +
      `rig: ${app.diag.rig}  model: ${ci.skinned ? "skinned" : "boxes"}\n` +
      `clips: ${ci.clips}/12\n` +
      (app.diag.lastErr ? `err: ${app.diag.lastErr}` : "err: none");
  }, 400);
}

// Resume audio on the very first interaction (autoplay policy).
const unlock = () => {
  app.audio.resume();
  app.audio.setMuted(app.config.muted);
  window.removeEventListener("pointerdown", unlock);
};
window.addEventListener("pointerdown", unlock);
