/**
 * Procedural team crests, mascot icons, and the game badge — all drawn to a 2D
 * canvas context so they can be used both as HUD/menu graphics and baked into 3D
 * textures (jumbotron, midfield). No external image assets.
 */

import { COLORS } from "./Theme";

export type EmblemIcon = "bolt" | "horn" | "fin" | "wing" | "viper" | "star" | "claw" | "flame";

export interface CrestTeam {
  abbr: string;
  icon: EmblemIcon;
  colors: { jersey: string; trim: string };
}

/** Trace a classic heater-shield path centered at (cx, cy) with radius r. */
function shieldPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  const w = r * 0.96;
  const top = cy - r;
  ctx.beginPath();
  ctx.moveTo(cx - w, top + r * 0.16);
  ctx.lineTo(cx - w, cy - r * 0.1);
  ctx.quadraticCurveTo(cx - w, cy + r * 0.55, cx, cy + r);
  ctx.quadraticCurveTo(cx + w, cy + r * 0.55, cx + w, cy - r * 0.1);
  ctx.lineTo(cx + w, top + r * 0.16);
  ctx.quadraticCurveTo(cx + w, top, cx + w - r * 0.18, top);
  ctx.lineTo(cx - w + r * 0.18, top);
  ctx.quadraticCurveTo(cx - w, top, cx - w, top + r * 0.16);
  ctx.closePath();
}

/** A bold white mascot icon, scaled to roughly fit within radius `r`. */
export function drawIcon(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  icon: EmblemIcon,
  color = "#ffffff",
): void {
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  switch (icon) {
    case "bolt": {
      ctx.beginPath();
      ctx.moveTo(cx + r * 0.35, cy - r);
      ctx.lineTo(cx - r * 0.45, cy + r * 0.12);
      ctx.lineTo(cx - r * 0.02, cy + r * 0.12);
      ctx.lineTo(cx - r * 0.3, cy + r);
      ctx.lineTo(cx + r * 0.5, cy - r * 0.18);
      ctx.lineTo(cx + r * 0.06, cy - r * 0.18);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case "horn": {
      // A pair of charging horns.
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(cx + s * r * 0.1, cy + r * 0.6);
        ctx.quadraticCurveTo(cx + s * r * 0.95, cy + r * 0.2, cx + s * r * 0.8, cy - r * 0.85);
        ctx.quadraticCurveTo(cx + s * r * 0.45, cy - r * 0.1, cx + s * r * 0.1, cy + r * 0.25);
        ctx.closePath();
        ctx.fill();
      }
      break;
    }
    case "fin": {
      ctx.beginPath();
      ctx.moveTo(cx - r * 0.7, cy + r * 0.7);
      ctx.quadraticCurveTo(cx + r * 0.2, cy + r * 0.5, cx + r * 0.55, cy - r * 0.9);
      ctx.quadraticCurveTo(cx + r * 0.1, cy + r * 0.1, cx - r * 0.7, cy + r * 0.7);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case "wing": {
      // Stretched hawk wings (double chevron).
      ctx.lineWidth = r * 0.28;
      for (const dy of [-r * 0.28, r * 0.18]) {
        ctx.beginPath();
        ctx.moveTo(cx - r, cy + dy + r * 0.2);
        ctx.lineTo(cx, cy + dy - r * 0.25);
        ctx.lineTo(cx + r, cy + dy + r * 0.2);
        ctx.stroke();
      }
      break;
    }
    case "viper": {
      ctx.lineWidth = r * 0.26;
      ctx.beginPath();
      ctx.moveTo(cx - r * 0.6, cy + r * 0.85);
      ctx.bezierCurveTo(cx + r * 0.9, cy + r * 0.4, cx - r * 0.9, cy - r * 0.3, cx + r * 0.55, cy - r * 0.85);
      ctx.stroke();
      // Fang head.
      ctx.beginPath();
      ctx.arc(cx + r * 0.55, cy - r * 0.85, r * 0.2, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "claw": {
      // Three raking claw slashes.
      ctx.lineWidth = r * 0.2;
      for (const dx of [-r * 0.42, 0, r * 0.42]) {
        ctx.beginPath();
        ctx.moveTo(cx + dx + r * 0.22, cy - r * 0.9);
        ctx.quadraticCurveTo(cx + dx - r * 0.05, cy, cx + dx - r * 0.32, cy + r * 0.9);
        ctx.stroke();
      }
      break;
    }
    case "flame": {
      // A licking flame.
      ctx.beginPath();
      ctx.moveTo(cx, cy + r);
      ctx.quadraticCurveTo(cx - r * 0.95, cy + r * 0.2, cx - r * 0.32, cy - r * 0.5);
      ctx.quadraticCurveTo(cx - r * 0.28, cy + r * 0.05, cx + r * 0.05, cy - r * 0.25);
      ctx.quadraticCurveTo(cx - r * 0.06, cy - r * 0.8, cx + r * 0.4, cy - r * 1.05);
      ctx.quadraticCurveTo(cx + r * 0.22, cy - r * 0.35, cx + r * 0.6, cy - r * 0.28);
      ctx.quadraticCurveTo(cx + r, cy + r * 0.35, cx, cy + r);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case "star":
    default: {
      ctx.beginPath();
      for (let i = 0; i < 10; i++) {
        const a = (Math.PI / 5) * i - Math.PI / 2;
        const rad = i % 2 === 0 ? r : r * 0.44;
        const px = cx + Math.cos(a) * rad;
        const py = cy + Math.sin(a) * rad;
        i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
      break;
    }
  }
  ctx.restore();
}

/** A polished team crest: shield, chevron, mascot icon, and abbreviation banner. */
export function drawCrest(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  team: CrestTeam,
): void {
  ctx.save();
  // Drop shadow.
  ctx.shadowColor = "rgba(0,0,0,0.45)";
  ctx.shadowBlur = r * 0.25;
  ctx.shadowOffsetY = r * 0.08;

  // Shield body.
  shieldPath(ctx, cx, cy, r);
  ctx.fillStyle = team.colors.jersey;
  ctx.fill();
  ctx.shadowColor = "transparent";

  // Inner top band (lighter) for depth.
  ctx.save();
  shieldPath(ctx, cx, cy, r);
  ctx.clip();
  ctx.fillStyle = "rgba(255,255,255,0.14)";
  ctx.fillRect(cx - r, cy - r, r * 2, r * 0.85);
  // Chevron accent.
  ctx.fillStyle = "rgba(0,0,0,0.18)";
  ctx.beginPath();
  ctx.moveTo(cx - r, cy + r * 0.1);
  ctx.lineTo(cx, cy + r * 0.42);
  ctx.lineTo(cx + r, cy + r * 0.1);
  ctx.lineTo(cx + r, cy + r * 0.45);
  ctx.lineTo(cx, cy + r * 0.78);
  ctx.lineTo(cx - r, cy + r * 0.45);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // Mascot icon (upper third).
  drawIcon(ctx, cx, cy - r * 0.32, r * 0.5, team.icon, "#ffffff");

  // Abbreviation.
  ctx.fillStyle = "#ffffff";
  ctx.font = `900 ${Math.round(r * 0.5)}px "Trebuchet MS", system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(team.abbr, cx, cy + r * 0.52);

  // Border.
  shieldPath(ctx, cx, cy, r);
  ctx.lineWidth = Math.max(2, r * 0.1);
  ctx.strokeStyle = team.colors.trim;
  ctx.stroke();
  ctx.lineWidth = Math.max(1, r * 0.04);
  ctx.strokeStyle = "rgba(255,255,255,0.6)";
  ctx.stroke();
  ctx.restore();
}

/** A bone (rounded bar with knuckle ends) for the crossed-bones motif. */
function drawBone(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, w: number): void {
  ctx.lineCap = "round";
  ctx.lineWidth = w;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  for (const [bx, by] of [[x1, y1], [x2, y2]] as const) {
    const a = Math.atan2(y2 - y1, x2 - x1) + Math.PI / 2;
    const o = w * 0.42;
    ctx.beginPath();
    ctx.arc(bx + Math.cos(a) * o, by + Math.sin(a) * o, w * 0.5, 0, Math.PI * 2);
    ctx.arc(bx - Math.cos(a) * o, by - Math.sin(a) * o, w * 0.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** A snarling skull, centred at (cx,cy), drawn to roughly fit radius r. */
function drawSkull(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string): void {
  ctx.save();
  ctx.fillStyle = color;
  // Cranium.
  ctx.beginPath();
  ctx.ellipse(cx, cy - r * 0.22, r * 0.62, r * 0.6, 0, 0, Math.PI * 2);
  ctx.fill();
  // Cheeks/jaw block.
  ctx.beginPath();
  ctx.moveTo(cx - r * 0.5, cy + r * 0.05);
  ctx.lineTo(cx - r * 0.34, cy + r * 0.62);
  ctx.lineTo(cx + r * 0.34, cy + r * 0.62);
  ctx.lineTo(cx + r * 0.5, cy + r * 0.05);
  ctx.closePath();
  ctx.fill();
  // Eye sockets (angled inward = angry).
  ctx.fillStyle = "#000";
  for (const s of [-1, 1]) {
    ctx.save();
    ctx.translate(cx + s * r * 0.27, cy - r * 0.16);
    ctx.rotate(s * 0.5);
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 0.22, r * 0.28, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  // Nasal cavity.
  ctx.beginPath();
  ctx.moveTo(cx, cy + r * 0.02);
  ctx.lineTo(cx - r * 0.1, cy + r * 0.24);
  ctx.lineTo(cx + r * 0.1, cy + r * 0.24);
  ctx.closePath();
  ctx.fill();
  // Teeth (notches in the jaw).
  ctx.lineWidth = Math.max(1, r * 0.05);
  ctx.strokeStyle = "#000";
  for (let i = -2; i <= 2; i++) {
    const tx = cx + i * r * 0.14;
    ctx.beginPath();
    ctx.moveTo(tx, cy + r * 0.38);
    ctx.lineTo(tx, cy + r * 0.62);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(cx - r * 0.34, cy + r * 0.38);
  ctx.lineTo(cx + r * 0.34, cy + r * 0.38);
  ctx.stroke();
  ctx.restore();
}

/**
 * The hardcore game emblem: a riveted, spiked steel roundel with a snarling skull
 * over crossed bones. Underground-league insignia, drawn entirely procedurally.
 */
export function drawHardcoreBadge(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  ctx.save();
  // Spiked rim.
  ctx.fillStyle = COLORS.steel;
  const spikes = 18;
  for (let i = 0; i < spikes; i++) {
    const a = (i / spikes) * Math.PI * 2;
    const a2 = a + (Math.PI / spikes) * 0.6;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * r * 0.96, cy + Math.sin(a) * r * 0.96);
    ctx.lineTo(cx + Math.cos((a + a2) / 2) * r * 1.16, cy + Math.sin((a + a2) / 2) * r * 1.16);
    ctx.lineTo(cx + Math.cos(a2) * r * 0.96, cy + Math.sin(a2) * r * 0.96);
    ctx.closePath();
    ctx.fill();
  }
  // Disc.
  ctx.shadowColor = "rgba(0,0,0,0.6)";
  ctx.shadowBlur = r * 0.25;
  ctx.fillStyle = COLORS.bg1;
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.98, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowColor = "transparent";
  // Blood ring + steel inner ring.
  ctx.lineWidth = r * 0.12;
  ctx.strokeStyle = COLORS.blood;
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.9, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = r * 0.03;
  ctx.strokeStyle = COLORS.steel;
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.78, 0, Math.PI * 2);
  ctx.stroke();
  // Rivets on the blood ring.
  ctx.fillStyle = "rgba(0,0,0,0.45)";
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(cx + Math.cos(a) * r * 0.9, cy + Math.sin(a) * r * 0.9, r * 0.03, 0, Math.PI * 2);
    ctx.fill();
  }
  // Crossed bones behind the skull.
  ctx.strokeStyle = COLORS.bone;
  ctx.fillStyle = COLORS.bone;
  ctx.globalAlpha = 0.92;
  drawBone(ctx, cx - r * 0.52, cy + r * 0.5, cx + r * 0.52, cy - r * 0.5, r * 0.11);
  drawBone(ctx, cx - r * 0.52, cy - r * 0.5, cx + r * 0.52, cy + r * 0.5, r * 0.11);
  ctx.globalAlpha = 1;
  // Skull.
  drawSkull(ctx, cx, cy - r * 0.02, r * 0.62, COLORS.bone);
  ctx.restore();
}

/** The league/game badge — a roundel with a football and "GB" monogram. */
export function drawGameBadge(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.5)";
  ctx.shadowBlur = r * 0.2;
  // Outer ring.
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = "#0b3d18";
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.lineWidth = r * 0.12;
  ctx.strokeStyle = "#ffd23a";
  ctx.stroke();
  ctx.lineWidth = r * 0.04;
  ctx.strokeStyle = "#ff7b1e";
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.82, 0, Math.PI * 2);
  ctx.stroke();

  // Football.
  ctx.save();
  ctx.translate(cx, cy - r * 0.04);
  ctx.rotate(-0.25);
  ctx.fillStyle = "#8a4b22";
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = r * 0.05;
  ctx.beginPath();
  ctx.ellipse(0, 0, r * 0.55, r * 0.34, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(-r * 0.22, 0);
  ctx.lineTo(r * 0.22, 0);
  ctx.moveTo(-r * 0.1, -r * 0.08);
  ctx.lineTo(-r * 0.1, r * 0.08);
  ctx.moveTo(r * 0.02, -r * 0.08);
  ctx.lineTo(r * 0.02, r * 0.08);
  ctx.stroke();
  ctx.restore();
  ctx.restore();
}
