import GUI from "lil-gui";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { GameApp } from "../engine/Game";
import type { GameState } from "../engine/GameState";
import type { Player } from "../game/entities/Player";
import { ANIM } from "../game/anim/tuning";

const _fwd = new THREE.Vector3();

/** A game state can expose the player the debug overlay should report on (controlled / carrier). */
export interface DebugSubjectProvider {
  debugSubject(): Player | null;
}

function hasSubject(s: GameState | null): s is GameState & DebugSubjectProvider {
  return !!s && typeof (s as Partial<DebugSubjectProvider>).debugSubject === "function";
}

/**
 * On-device tuning overlay (the menu's DEBUG button). Owns a lil-gui panel that live-edits the
 * procedural-animation constants (ANIM) and shows live motion readouts for the focused player, so
 * the feel of the locomotion can be dialled in on real hardware. Free camera + screen capture are
 * layered on in later commits.
 */
export class DebugMode {
  private readonly app: GameApp;
  private readonly gui: GUI;
  private readonly controls: OrbitControls;
  /** Full-screen transparent input layer that OrbitControls listens on while free-cam is active, so
   *  camera control is fully isolated from the game's pointer handling on the canvas below. */
  private readonly camLayer: HTMLDivElement;
  /** Live readouts (lil-gui `.listen()`s these object fields each frame). */
  private readonly out = { fps: 60, focus: "—", speed: 0, speed01: 0, gait: "—", accel: 0, turnRate: 0 };
  private fpsEMA = 60;
  private lastSubject: Player | null = null;
  /** Active contact-sheet burst: composites N frames spaced a few render frames apart into a grid. */
  private burst: {
    frames: number; captured: number; everyN: number; counter: number;
    grid: HTMLCanvasElement; gctx: CanvasRenderingContext2D; cols: number; cw: number; ch: number;
  } | null = null;

  constructor(app: GameApp) {
    this.app = app;
    this.gui = new GUI({ title: "DEBUG — Animation Tuning" });

    // Free camera. The game's Input owns pointer events on the canvas (it even pointer-captures),
    // so OrbitControls listens on its OWN full-screen layer that we only mount while free-cam is on.
    // touch-action:none lets it get multi-touch pinch/pan; it sits above the canvas but below the
    // panel (so the Free camera toggle stays tappable to turn it back off).
    this.camLayer = document.createElement("div");
    this.camLayer.style.cssText =
      "position:fixed;inset:0;z-index:5;touch-action:none;display:none;background:transparent;";
    document.body.appendChild(this.camLayer);
    this.gui.domElement.style.zIndex = "20"; // keep the panel above the camera layer
    // 1-finger rotate, 2-finger pinch-zoom + pan (mouse: drag rotate, wheel zoom, right-drag pan).
    this.controls = new OrbitControls(app.scene3d.getCamera(), this.camLayer);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.enabled = false;
    const cam = { freeCam: false, frame: () => this.frameSubject() };
    const camF = this.gui.addFolder("Camera");
    camF.add(cam, "freeCam").name("Free camera").onChange((v: boolean) => this.setFreeCam(v));
    camF.add(cam, "frame").name("Center on player");

    // Pause freezes the gameplay sim + animation pose so the camera can be set up at leisure
    // (snap → pause → orbit to the angle → unpause to watch it play from there).
    this.gui.addFolder("Playback").add(this.app, "paused").name("⏸ Pause game").listen();

    // Capture (downloads to the device — share the PNGs back for tuning review). The contact sheet
    // is a 3×3 grid of frames over ~1s: a single image that shows a whole motion cycle (stride / cut
    // / foot plant), since still images — not video — are what can be reviewed.
    const cap = { shot: () => this.screenshot(), sheet: () => this.startContactSheet() };
    const capF = this.gui.addFolder("Capture");
    capF.add(cap, "shot").name("Screenshot PNG");
    capF.add(cap, "sheet").name("Anim contact sheet");

    const lean = this.gui.addFolder("Weight lean");
    lean.add(ANIM, "ACCEL_LEAN");
    lean.add(ANIM, "LEAN_ACCEL_GAIN", 0, 0.0006, 0.00001);
    lean.add(ANIM, "LEAN_PITCH_MAX", 0, 0.5, 0.01);
    lean.add(ANIM, "BANK_ACCEL_GAIN", 0, 0.0006, 0.00001);

    const hip = this.gui.addFolder("Hip motion");
    hip.add(ANIM, "PROC_HIP");
    hip.add(ANIM, "HIP_BOB_AMP", 0, 0.12, 0.002);
    hip.add(ANIM, "HIP_ROLL_AMP", 0, 0.1, 0.002);

    const ik = this.gui.addFolder("Foot IK");
    ik.add(ANIM, "FOOT_IK");
    ik.add(ANIM, "FOOT_IK_WEIGHT", 0, 1, 0.05);
    ik.add(ANIM, "FOOT_PLANT_LO", 0, 0.5, 0.005);
    ik.add(ANIM, "FOOT_PLANT_HI", 0, 1, 0.01);

    const ro = this.gui.addFolder("Readouts");
    ro.add(this.out, "fps").listen().disable();
    ro.add(this.out, "focus").listen().disable();
    ro.add(this.out, "speed").listen().disable();
    ro.add(this.out, "speed01").listen().disable();
    ro.add(this.out, "gait").listen().disable();
    ro.add(this.out, "accel").listen().disable();
    ro.add(this.out, "turnRate").listen().disable();

    // Dump current tuning so it can be pasted back to share / persist.
    this.gui.add({ copy: () => this.copyTuning() }, "copy").name("Copy tuning JSON");
  }

  /** Per-frame: refresh readouts from the focused player of the active state. */
  update(dt: number, state: GameState | null): void {
    if (dt > 0) this.fpsEMA += (1 / dt - this.fpsEMA) * 0.1;
    this.out.fps = Math.round(this.fpsEMA);
    const p = hasSubject(state) ? state.debugSubject() : null;
    this.lastSubject = p;
    if (p) {
      this.out.focus = `${p.team} ${p.role} #${p.number}`;
      this.out.speed = Math.round(p.loco.speed);
      this.out.speed01 = +p.loco.speed01.toFixed(2);
      this.out.gait = p.loco.gait;
      this.out.accel = Math.round(Math.hypot(p.loco.accelX, p.loco.accelY));
      this.out.turnRate = +p.loco.turnRate.toFixed(2);
    } else {
      this.out.focus = "—";
    }
    if (this.controls.enabled) this.controls.update();
    this.driveBurst();
  }

  // --- capture ------------------------------------------------------------------------------------

  private screenshot(): void {
    this.app.scene3d.requestCapture((c) =>
      this.downloadURL(c.toDataURL("image/png"), `gridiron-shot-${this.stamp()}.png`),
    );
  }

  private startContactSheet(): void {
    if (this.burst) return;
    const src = this.app.scene3d.canvas;
    const cols = 3;
    const frames = 9;
    const scale = 0.5; // half-res cells keep the grid PNG a sensible size
    const cw = Math.max(1, Math.round(src.width * scale));
    const ch = Math.max(1, Math.round(src.height * scale));
    const grid = document.createElement("canvas");
    grid.width = cw * cols;
    grid.height = ch * Math.ceil(frames / cols);
    const gctx = grid.getContext("2d");
    if (!gctx) return;
    gctx.fillStyle = "#000";
    gctx.fillRect(0, 0, grid.width, grid.height);
    this.burst = { frames, captured: 0, everyN: 6, counter: 6, grid, gctx, cols, cw, ch };
  }

  /** Advance an in-progress contact-sheet burst: every `everyN` frames, snapshot the 3D canvas into
   *  the next grid cell; finalize + download after the last frame. */
  private driveBurst(): void {
    const b = this.burst;
    if (!b) return;
    b.counter++;
    if (b.counter < b.everyN || b.captured >= b.frames) return;
    b.counter = 0;
    const idx = b.captured++;
    this.app.scene3d.requestCapture((c) => {
      const col = idx % b.cols;
      const row = Math.floor(idx / b.cols);
      b.gctx.drawImage(c, col * b.cw, row * b.ch, b.cw, b.ch);
      if (idx === b.frames - 1) {
        this.downloadURL(b.grid.toDataURL("image/png"), `gridiron-anim-${this.stamp()}.png`);
        this.burst = null;
      }
    });
  }

  private downloadURL(url: string, name: string): void {
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  private stamp(): string {
    return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  }

  private setFreeCam(on: boolean): void {
    this.app.scene3d.freeCam = on;
    this.controls.enabled = on;
    this.camLayer.style.display = on ? "block" : "none";
    if (on) this.frameSubject();
  }

  /** Center the orbit on the focused player (or, if none, on the point the camera is looking at). */
  private frameSubject(): void {
    const cam = this.app.scene3d.getCamera();
    if (this.lastSubject) {
      this.app.scene3d.fieldToWorld(this.lastSubject.pos.x, this.lastSubject.pos.y, this.controls.target);
    } else {
      cam.getWorldDirection(_fwd);
      this.controls.target.copy(cam.position).addScaledVector(_fwd, 16);
    }
    this.controls.update();
  }

  private copyTuning(): void {
    const json = JSON.stringify(ANIM, null, 2);
    void navigator.clipboard?.writeText(json).catch(() => {});
    console.log("[DEBUG] ANIM tuning —\n" + json);
  }

  dispose(): void {
    this.app.scene3d.freeCam = false;
    this.controls.dispose();
    this.camLayer.remove();
    this.gui.destroy();
  }
}
