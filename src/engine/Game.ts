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
import { loadCharacter } from "../game/CharacterModel";
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
    // Load the skinned character in the background; players use box avatars until ready.
    loadCharacter(`${import.meta.env.BASE_URL}character.fbx`)
      .then((asset) => this.scene3d.setCharacter(asset))
      .catch((err) => console.warn("character model failed to load; using box avatars", err));
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
