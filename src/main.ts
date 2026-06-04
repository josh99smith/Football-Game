import "./styles.css";
import { GameApp } from "./engine/Game";
import { MenuState } from "./game/states/MenuState";

const canvas = document.getElementById("game") as HTMLCanvasElement | null;
if (!canvas) throw new Error("missing #game canvas");

const app = new GameApp(canvas);
app.start(new MenuState(app));

// Resume audio on the very first interaction (autoplay policy).
const unlock = () => {
  app.audio.resume();
  app.audio.setMuted(app.config.muted);
  window.removeEventListener("pointerdown", unlock);
};
window.addEventListener("pointerdown", unlock);
