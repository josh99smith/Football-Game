import { Renderer } from "./Renderer";
import { Camera } from "./Camera";
import { Input } from "./Input";
import { Loop } from "./Loop";
import { AudioManager } from "./audio/AudioManager";
import { ParticleSystem } from "./fx/ParticleSystem";
import { FloatingText } from "./fx/FloatingText";
import { ScreenShake } from "./fx/ScreenShake";
import { TimeScale } from "./fx/TimeScale";
import type { GameState } from "./GameState";
import { Field } from "../game/Field";
import { Scene3D } from "../game/Scene3D";
import { loadBaseRig, loadAnimationClips, clipsComplete, loadedClipCount, type CharacterAsset } from "../game/CharacterModel";
import { Match } from "../game/Match";
import { TEAMS } from "../game/Team";
import { loadHighScores, type HighScore } from "../game/storage";

export interface SessionConfig {
  homeTeamIndex: number;
  awayTeamIndex: number;
  difficulty: Match["difficulty"];
  quarterLength: number;
  muted: boolean;
}

/**
 * Top-level application: owns the engine services, the active game state, and the
 * shared session/match data. States are swapped via `setState`.
 */
export class GameApp {
  readonly r: Renderer;
  readonly cam: Camera;
  readonly input: Input;
  readonly audio: AudioManager;
  readonly field: Field;
  readonly scene3d: Scene3D;

  readonly particles: ParticleSystem;
  readonly floating: FloatingText;
  readonly shake: ScreenShake;
  readonly time: TimeScale;

  private readonly loop: Loop;
  private state: GameState | null = null;
  private nextState: GameState | null = null;

  /** Persistent session selections. */
  config: SessionConfig = {
    homeTeamIndex: 0,
    awayTeamIndex: 1,
    difficulty: "pro",
    quarterLength: 90,
    muted: false,
  };

  /** The live match (created when a game starts). */
  match!: Match;
  highScores: HighScore[] = loadHighScores();

  private rotatePrompt: HTMLElement | null;

  constructor(canvas: HTMLCanvasElement, canvas3d: HTMLCanvasElement) {
    this.r = new Renderer(canvas);
    this.cam = new Camera();
    this.cam.setViewport(this.r.width, this.r.height);
    this.input = new Input(canvas);
    this.audio = new AudioManager();
    this.field = new Field();
    this.scene3d = new Scene3D(canvas3d, this.field);
    this.scene3d.setVisible(false);
    // Load the skinned character in the background; players use box avatars only until it's ready.
    const base = import.meta.env.BASE_URL;
    const urls = {
      model: `${base}rig_stance.fbx`,
      run: `${base}standard_run.fbx`,
      runBack: `${base}run_backward.fbx`,
      strafe: `${base}strafe.fbx`,
      pass: `${base}rig_pass.fbx`,
      catch: `${base}rig_catch.fbx`,
      juke: `${base}change_dir.fbx`,
      walk: `${base}walk.fbx`,
      tackle: `${base}tackle.fbx`,
      spin: `${base}spin.fbx`,
      defTackle: `${base}def_tackle.fbx`,
      defSwat: `${base}def_swat.fbx`,
      celebrate: `${base}celebrate.fbx`,
    };
    // Two-stage load so the skinned model appears ASAP: (1) the ~1MB rig swaps box avatars for the
    // model immediately (idle only); (2) the animation clips stream in and upgrade it. A slow or
    // stalled clip fetch on mobile can therefore never leave the player stuck on blocks.
    // Stream the animation clips onto the rig, and KEEP retrying any that fail until the whole set
    // is in. loadAnimationClips only re-fetches the clips still missing from `asset`, so a clip
    // that blipped on a flaky mobile connection streams in on a later pass instead of being
    // silently disabled forever — animations can be a beat late, but never absent.
    const loadAnims = (asset: CharacterAsset, attempt = 0): void => {
      const before = loadedClipCount(asset);
      const retry = (next: CharacterAsset): void => {
        if (clipsComplete(next) || attempt >= 40) return;
        setTimeout(() => loadAnims(next, attempt + 1), Math.min(8000, 1500 * (attempt + 1)));
      };
      loadAnimationClips(asset, urls)
        .then((full) => {
          // Only rebuild the avatar pool when a pass actually added a clip (avoids churn on a
          // retry where everything still failed).
          if (attempt === 0 || loadedClipCount(full) > before) this.scene3d.setCharacter(full);
          retry(full);
        })
        .catch((err) => {
          console.warn(`animation clips load issue (model is up, retrying)`, err);
          retry(asset);
        });
    };
    const loadRig = (attempt = 0): void => {
      loadBaseRig(urls.model)
        .then((rig) => {
          this.scene3d.setCharacter(rig); // model is visible NOW (idle); clips follow
          loadAnims(rig);
        })
        .catch((err) => {
          console.error(`base rig load failed (attempt ${attempt + 1}); retrying…`, err);
          if (attempt < 10) setTimeout(() => loadRig(attempt + 1), 1500 * (attempt + 1));
        });
    };
    loadRig();
    this.particles = new ParticleSystem();
    this.floating = new FloatingText();
    this.shake = new ScreenShake();
    this.time = new TimeScale();
    this.rotatePrompt = document.getElementById("rotate-prompt");

    this.loop = new Loop(this.tick, this.draw);
    window.addEventListener("resize", this.onResize);
    this.onResize();
  }

  /** Build a fresh Match from the current config. */
  newMatch(): Match {
    const home = TEAMS[this.config.homeTeamIndex % TEAMS.length];
    const away = TEAMS[this.config.awayTeamIndex % TEAMS.length];
    this.match = new Match(home, away, {
      quarterLength: this.config.quarterLength,
      difficulty: this.config.difficulty,
    });
    return this.match;
  }

  setState(s: GameState): void {
    // Defer the swap until the end of the frame to avoid mutating mid-update.
    this.nextState = s;
  }

  start(initial: GameState): void {
    this.state = initial;
    this.state.enter?.();
    this.loop.start();
  }

  private onResize = (): void => {
    this.r.resize();
    this.cam.setViewport(this.r.width, this.r.height);
    this.scene3d.resize(this.r.width, this.r.height, this.r.dpr);
    this.updateOrientationPrompt();
  };

  private updateOrientationPrompt(): void {
    if (!this.rotatePrompt) return;
    // Prompt to rotate only on small portrait screens (phones).
    const portrait = this.r.height > this.r.width;
    const small = Math.min(this.r.width, this.r.height) < 520;
    this.rotatePrompt.classList.toggle("hidden", !(portrait && small));
  }

  private tick = (dt: number): void => {
    this.input.update();
    const scale = this.time.update(dt);
    const scaled = dt * scale;

    this.state?.update(scaled);

    // Global FX advance on real time so they don't freeze during hit-stop.
    this.shake.update(dt);
    this.cam.shakeX = this.shake.offsetX;
    this.cam.shakeY = this.shake.offsetY;
    this.particles.update(scaled);
    this.floating.update(scaled);

    if (this.nextState) {
      this.state?.exit?.();
      this.state = this.nextState;
      this.nextState = null;
      // Hide the 3D field by default; only LivePlayState re-shows it on enter.
      this.scene3d.setVisible(false);
      this.state.enter?.();
    }
  };

  private draw = (alpha: number): void => {
    // The 2D canvas is a transparent overlay above the WebGL field; each state
    // paints its own opaque background (menus) or leaves it clear (live play).
    this.r.clear();
    this.state?.render(alpha);
  };
}
