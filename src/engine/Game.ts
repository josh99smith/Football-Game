import { Renderer } from "./Renderer";
import { Camera } from "./Camera";
import { Input } from "./Input";
import { Loop } from "./Loop";
import { AudioManager } from "./audio/AudioManager";
import { ParticleSystem } from "./fx/ParticleSystem";
import { FloatingText } from "./fx/FloatingText";
import { Banner } from "./fx/Banner";
import { ScreenShake } from "./fx/ScreenShake";
import { TimeScale } from "./fx/TimeScale";
import type { GameState } from "./GameState";
import { Field } from "../game/Field";
import { Scene3D } from "../game/Scene3D";
import { loadBaseRig, loadAnimationClips, clipsComplete, loadedClipCount, locomotionReady, type CharacterAsset } from "../game/CharacterModel";
import { Match } from "../game/Match";
import { TEAMS } from "../game/Team";
import { loadHighScores, type HighScore } from "../game/storage";
import { DebugMode } from "../debug/DebugMode";

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
  readonly banner: Banner;
  readonly shake: ScreenShake;
  readonly time: TimeScale;

  private readonly loop: Loop;
  private state: GameState | null = null;
  private nextState: GameState | null = null;
  /** On-device tuning overlay; created lazily while a debug-mode match is live, else null. */
  private debug: DebugMode | null = null;
  /** DEBUG: when true, freeze the gameplay sim + animation pose (toggled from the debug overlay). */
  paused = false;

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

  /** Asset-load state surfaced by the optional #diag overlay (remote debugging on phones). */
  diag = { rig: "loading", lastErr: "" };

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
      // Apply the model the instant the locomotion clips are in (run/walk/strafe/backpedal) so a
      // moving player animates without waiting on the heavier one-shot clips behind them.
      let appliedLoco = locomotionReady(asset);
      const onProgress = (partial: CharacterAsset): void => {
        if (!appliedLoco && locomotionReady(partial)) { appliedLoco = true; this.scene3d.setCharacter(partial); }
      };
      loadAnimationClips(asset, urls, onProgress)
        .then((full) => {
          // Rebuild on the final result when a pass added clips (or first pass / loco not yet shown).
          if (attempt === 0 || !appliedLoco || loadedClipCount(full) > before) this.scene3d.setCharacter(full);
          retry(full);
        })
        .catch((err) => {
          console.warn(`animation clips load issue (model is up, retrying)`, err);
          this.diag.lastErr = String(err).slice(0, 120);
          retry(asset);
        });
    };
    const loadRig = (attempt = 0): void => {
      loadBaseRig(urls.model)
        .then((rig) => {
          this.diag.rig = "ok";
          this.scene3d.setCharacter(rig); // model is visible NOW (idle); clips follow
          loadAnims(rig);
        })
        .catch((err) => {
          console.error(`base rig load failed (attempt ${attempt + 1}); retrying…`, err);
          this.diag.rig = `retry ${attempt + 1}`;
          this.diag.lastErr = String(err).slice(0, 120);
          if (attempt < 10) setTimeout(() => loadRig(attempt + 1), 1500 * (attempt + 1));
        });
    };
    loadRig();
    this.particles = new ParticleSystem();
    this.floating = new FloatingText();
    this.banner = new Banner();
    this.shake = new ScreenShake();
    this.time = new TimeScale();
    this.rotatePrompt = document.getElementById("rotate-prompt");

    this.loop = new Loop(this.tick, this.draw);
    window.addEventListener("resize", this.onResize);
    // Polite citizen: silence audio while the tab/app is backgrounded; restore on return.
    document.addEventListener("visibilitychange", () => this.audio.setPageHidden(document.hidden));
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
    // Paint the turf for this matchup: team-colored, team-named end zones + the home crest at the 50.
    this.scene3d.setFieldTeams(home, away);
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

    // DEBUG pause: freeze the gameplay sim (and, via scene3d.paused, the animation pose) so the
    // camera can be repositioned without time pressure. The DEBUG overlay below still updates so the
    // free camera / panel stay responsive while paused.
    if (!this.paused) this.state?.update(scaled);
    this.scene3d.paused = this.paused;

    // DEBUG overlay: live only while a debug-mode match runs (the menu clears the flag on return).
    if (this.match?.debugMode) {
      (this.debug ??= new DebugMode(this)).update(dt, this.state);
    } else if (this.debug) {
      this.debug.dispose();
      this.debug = null;
      this.paused = false; // never leave a non-debug state frozen
    }

    // Global FX advance on real time so they don't freeze during hit-stop (skipped while paused).
    if (!this.paused) {
      this.shake.update(dt);
      this.cam.shakeX = this.shake.offsetX;
      this.cam.shakeY = this.shake.offsetY;
      this.particles.update(scaled);
      this.floating.update(scaled);
    }
    this.banner.update(dt); // UI call-out: real time, so bullet-time doesn't stall it

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
    this.banner.render(this.r); // marquee call-outs ride above every state
  };
}
