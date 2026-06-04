import type { Renderer } from "../engine/Renderer";
import type { ControlLayout, Input } from "../engine/Input";

/**
 * On-screen virtual controls: a floating joystick on the left half and two action
 * buttons (TURBO + ACTION) in the bottom-right. Also supplies the hit-region layout
 * to the Input system each frame so it can interpret raw pointers.
 */
export class TouchControls {
  visible = true;

  private layout: ControlLayout = {
    turbo: { x: 0, y: 0, r: 0 },
    action: { x: 0, y: 0, r: 0 },
    joystickZoneRight: 0,
  };

  /** Recompute button placement for the current screen size. */
  computeLayout(r: Renderer): ControlLayout {
    const margin = 26;
    const actionR = Math.max(40, Math.min(58, r.height * 0.1));
    const turboR = actionR * 0.82;
    const ax = r.width - margin - actionR;
    const ay = r.height - margin - actionR;
    const tx = ax - actionR - turboR - 4;
    const ty = ay + actionR - turboR;
    this.layout = {
      action: { x: ax, y: ay, r: actionR },
      turbo: { x: tx, y: ty, r: turboR },
      joystickZoneRight: r.width * 0.52,
    };
    return this.layout;
  }

  private button(r: Renderer, x: number, y: number, rad: number, label: string, color: string, pressed: boolean): void {
    const ctx = r.ctx;
    ctx.globalAlpha = pressed ? 0.9 : 0.55;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, rad, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = pressed ? 1 : 0.8;
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#fff";
    ctx.font = `900 ${Math.round(rad * 0.5)}px "Trebuchet MS", system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, x, y);
  }

  render(r: Renderer, input: Input, labels: { turbo: string; action: string }): void {
    if (!this.visible) return;
    const ctx = r.ctx;

    // Joystick (only while engaged).
    if (input.joystickActive) {
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(input.joystickOrigin.x, input.joystickOrigin.y, 56, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = "#ffe24a";
      ctx.beginPath();
      ctx.arc(input.joystickKnob.x, input.joystickKnob.y, 26, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    this.button(r, this.layout.turbo.x, this.layout.turbo.y, this.layout.turbo.r, labels.turbo, "#1c6fd0", input.turbo);
    this.button(r, this.layout.action.x, this.layout.action.y, this.layout.action.r, labels.action, "#d03a3a", input.action);
  }
}
