import type { Renderer } from "../engine/Renderer";
import type { ControlLayout, Input, CircleRegion } from "../engine/Input";

export type ActionIcon = "pass" | "dive" | "switch" | "juke" | "spin" | "tackle" | "turbo";

export interface ControlLabels {
  /** The single contextual action button (Hike / Pass / Catch / Juke / Tackle / Switch). */
  action: { text: string; icon: ActionIcon; color: string };
}

/**
 * On-screen controls styled after arcade football: a fixed d-pad on the lower-left
 * and a two-button cluster on the lower-right — TURBO plus one big, context-sensitive
 * ACTION button whose label/glyph changes with the situation.
 */
export class TouchControls {
  visible = true;
  private layout: ControlLayout = {
    turbo: { x: 0, y: 0, r: 0 },
    action: { x: 0, y: 0, r: 0 },
    action2: { x: 0, y: 0, r: 0 },
    joystick: { x: 0, y: 0, r: 56 },
    joystickZoneRight: 0,
  };

  computeLayout(r: Renderer, debug = false): ControlLayout {
    const margin = 24;
    // Pad the edge margins by the display safe-area insets so the thumb clusters never sit under a
    // notch or the home indicator on phones (landscape: side notch + bottom home bar).
    const mL = margin + r.safe.left;
    const mR = margin + r.safe.right;
    const mB = margin + r.safe.bottom;
    const big = Math.max(40, Math.min(58, r.height * 0.1));
    const small = big * 0.9;
    const jr = 56;
    const jx = mL + 64;
    const jy = r.height - mB - 64;
    if (debug) {
      // DEBUG layout: stack ACTION + TURBO on the LEFT, directly above the joystick, so the whole
      // game can be driven with the left thumb while the right hand works the camera / tuning panel.
      const ay = jy - jr - 12 - big;
      const ty = ay - big - 10 - small;
      this.layout = {
        action: { x: jx, y: ay, r: big },
        turbo: { x: jx, y: ty, r: small },
        action2: { x: 0, y: 0, r: 0 },
        joystick: { x: jx, y: jy, r: jr },
        joystickZoneRight: r.width * 0.5,
      };
      return this.layout;
    }
    // Right-hand cluster: the big ACTION button sits in the corner (primary thumb
    // position) with TURBO up and to its left.
    const ax = r.width - mR - big;
    const ay = r.height - mB - big;
    this.layout = {
      action: { x: ax, y: ay, r: big },
      turbo: { x: ax - big * 1.7, y: ay - big * 0.5, r: small },
      action2: { x: 0, y: 0, r: 0 }, // unused in the two-button setup (never hit-tests)
      joystick: { x: jx, y: jy, r: jr },
      joystickZoneRight: r.width * 0.5,
    };
    return this.layout;
  }

  render(r: Renderer, input: Input, labels: ControlLabels): void {
    if (!this.visible) return;
    this.dpad(r, input);
    this.button(r, this.layout.turbo, "TURBO", "turbo", "#e23b3b", input.turbo);
    this.button(r, this.layout.action, labels.action.text, labels.action.icon, labels.action.color, input.action);
  }

  private dpad(r: Renderer, input: Input): void {
    const ctx = r.ctx;
    const j = this.layout.joystick;
    // Base.
    ctx.globalAlpha = 0.32;
    ctx.fillStyle = "#0b1726";
    ctx.beginPath();
    ctx.arc(j.x, j.y, j.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#9fb6cc";
    ctx.stroke();
    // Direction ticks.
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    for (let i = 0; i < 4; i++) {
      const a = (Math.PI / 2) * i;
      const tx = j.x + Math.cos(a) * (j.r - 12);
      const ty = j.y + Math.sin(a) * (j.r - 12);
      ctx.save();
      ctx.translate(tx, ty);
      ctx.rotate(a);
      ctx.beginPath();
      ctx.moveTo(6, 0);
      ctx.lineTo(-3, -5);
      ctx.lineTo(-3, 5);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    // Knob.
    const kx = input.joystickActive ? input.joystickKnob.x : j.x;
    const ky = input.joystickActive ? input.joystickKnob.y : j.y;
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = "#e9eef4";
    ctx.beginPath();
    ctx.arc(kx, ky, j.r * 0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  private button(r: Renderer, c: CircleRegion, label: string, icon: ActionIcon, color: string, pressed: boolean): void {
    const ctx = r.ctx;
    ctx.save();
    // Drop shadow + body with a subtle radial highlight.
    ctx.shadowColor = "rgba(0,0,0,0.5)";
    ctx.shadowBlur = pressed ? 4 : 10;
    ctx.shadowOffsetY = 3;
    const grad = ctx.createRadialGradient(c.x - c.r * 0.3, c.y - c.r * 0.4, c.r * 0.2, c.x, c.y, c.r);
    grad.addColorStop(0, lighten(color, pressed ? 0.05 : 0.28));
    grad.addColorStop(1, color);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(c.x, c.y, c.r * (pressed ? 0.94 : 1), 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.stroke();

    drawActionGlyph(ctx, c.x, c.y - c.r * 0.12, c.r * 0.5, icon);

    ctx.fillStyle = "#fff";
    ctx.font = `900 ${Math.round(c.r * 0.34)}px "Trebuchet MS", system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, c.x, c.y + c.r * 0.56);
    ctx.restore();
  }
}

function lighten(hex: string, amt: number): string {
  const n = parseInt(hex.replace("#", ""), 16);
  const r = Math.min(255, ((n >> 16) & 255) + amt * 255);
  const g = Math.min(255, ((n >> 8) & 255) + amt * 255);
  const b = Math.min(255, (n & 255) + amt * 255);
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

/** White glyphs for the action buttons. */
function drawActionGlyph(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, icon: ActionIcon): void {
  ctx.save();
  ctx.fillStyle = "#fff";
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = r * 0.18;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  switch (icon) {
    case "pass": {
      // Football.
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(-0.3);
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.ellipse(0, 0, r, r * 0.62, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#1c3a6e";
      ctx.lineWidth = r * 0.12;
      ctx.beginPath();
      ctx.moveTo(-r * 0.4, 0);
      ctx.lineTo(r * 0.4, 0);
      ctx.stroke();
      ctx.restore();
      break;
    }
    case "juke": {
      // Running figure (chevron legs + body).
      ctx.beginPath();
      ctx.arc(cx, cy - r * 0.6, r * 0.26, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(cx - r * 0.5, cy + r * 0.7);
      ctx.lineTo(cx, cy - r * 0.1);
      ctx.lineTo(cx + r * 0.5, cy + r * 0.7);
      ctx.moveTo(cx - r * 0.45, cy);
      ctx.lineTo(cx + r * 0.5, cy - r * 0.15);
      ctx.stroke();
      break;
    }
    case "dive": {
      // Diving/lunge arrow.
      ctx.beginPath();
      ctx.moveTo(cx - r * 0.7, cy + r * 0.5);
      ctx.lineTo(cx + r * 0.6, cy - r * 0.6);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx + r * 0.6, cy - r * 0.6);
      ctx.lineTo(cx + r * 0.1, cy - r * 0.6);
      ctx.moveTo(cx + r * 0.6, cy - r * 0.6);
      ctx.lineTo(cx + r * 0.6, cy - r * 0.1);
      ctx.stroke();
      break;
    }
    case "tackle": {
      // Burst/impact star.
      for (let i = 0; i < 8; i++) {
        const a = (Math.PI / 4) * i;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * r * 0.3, cy + Math.sin(a) * r * 0.3);
        ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
        ctx.stroke();
      }
      break;
    }
    case "spin": {
      // A full circular arrow (the spin move).
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.66, Math.PI * 0.55, Math.PI * 2.25);
      ctx.stroke();
      // Arrowhead at the open end.
      const a = Math.PI * 2.25;
      const hx = cx + Math.cos(a) * r * 0.66;
      const hy = cy + Math.sin(a) * r * 0.66;
      ctx.beginPath();
      ctx.moveTo(hx, hy);
      ctx.lineTo(hx - r * 0.32, hy - r * 0.12);
      ctx.moveTo(hx, hy);
      ctx.lineTo(hx - r * 0.05, hy - r * 0.4);
      ctx.stroke();
      break;
    }
    case "switch": {
      // Two opposing arrows (swap).
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.6, Math.PI * 0.3, Math.PI * 1.5);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx + r * 0.55, cy - r * 0.45);
      ctx.lineTo(cx + r * 0.2, cy - r * 0.5);
      ctx.moveTo(cx + r * 0.55, cy - r * 0.45);
      ctx.lineTo(cx + r * 0.6, cy - r * 0.05);
      ctx.stroke();
      break;
    }
    case "turbo": {
      // Flame.
      ctx.beginPath();
      ctx.moveTo(cx, cy + r * 0.9);
      ctx.quadraticCurveTo(cx - r * 0.85, cy + r * 0.2, cx - r * 0.3, cy - r * 0.4);
      ctx.quadraticCurveTo(cx - r * 0.25, cy + r * 0.05, cx + r * 0.05, cy - r * 0.2);
      ctx.quadraticCurveTo(cx - r * 0.05, cy - r * 0.7, cx + r * 0.35, cy - r);
      ctx.quadraticCurveTo(cx + r * 0.2, cy - r * 0.3, cx + r * 0.55, cy - r * 0.25);
      ctx.quadraticCurveTo(cx + r * 0.9, cy + r * 0.3, cx, cy + r * 0.9);
      ctx.closePath();
      ctx.fill();
      break;
    }
  }
  ctx.restore();
}
