import "./styles.css";
import { GameApp } from "./engine/Game";
import { MenuState } from "./game/states/MenuState";

const canvas = document.getElementById("game") as HTMLCanvasElement | null;
const canvas3d = document.getElementById("game3d") as HTMLCanvasElement | null;
if (!canvas || !canvas3d) throw new Error("missing game canvases");

const app = new GameApp(canvas, canvas3d);
app.start(new MenuState(app));

// Dev-only handle for headless/scripted testing (stripped from production builds).
if (import.meta.env.DEV) (window as unknown as { __app: GameApp }).__app = app;

// Resume audio on the very first interaction (autoplay policy).
const unlock = () => {
  app.audio.resume();
  app.audio.setMuted(app.config.muted);
  window.removeEventListener("pointerdown", unlock);
};
window.addEventListener("pointerdown", unlock);
