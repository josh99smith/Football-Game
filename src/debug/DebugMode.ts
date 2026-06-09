import GUI from "lil-gui";
import type { GameState } from "../engine/GameState";
import type { Player } from "../game/entities/Player";
import { ANIM } from "../game/anim/tuning";

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
  private readonly gui: GUI;
  /** Live readouts (lil-gui `.listen()`s these object fields each frame). */
  private readonly out = { fps: 60, focus: "—", speed: 0, speed01: 0, gait: "—", accel: 0, turnRate: 0 };
  private fpsEMA = 60;

  constructor() {
    this.gui = new GUI({ title: "DEBUG — Animation Tuning" });

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
  }

  private copyTuning(): void {
    const json = JSON.stringify(ANIM, null, 2);
    void navigator.clipboard?.writeText(json).catch(() => {});
    console.log("[DEBUG] ANIM tuning —\n" + json);
  }

  dispose(): void {
    this.gui.destroy();
  }
}
