import { clamp, normalize, type Vec2 } from "./math/Vec2";

export interface CircleRegion {
  x: number;
  y: number;
  r: number;
}

/** Button hit-regions supplied by the UI each frame (positions depend on screen size). */
export interface ControlLayout {
  turbo: CircleRegion;
  action: CircleRegion;
  /** Pointers starting left of this screen X drive the virtual joystick. */
  joystickZoneRight: number;
}

interface Pointer {
  id: number;
  x: number;
  y: number;
  startX: number;
  startY: number;
  startTime: number;
  role: "joystick" | "turbo" | "action" | "tap";
  moved: boolean;
}

const JOYSTICK_RADIUS = 56; // px of travel for full deflection

/**
 * Unified input: merges touch (virtual joystick + two action buttons) and keyboard
 * into a single "intent" each frame, plus tap events for menus. Edge transitions
 * (pressed/released) are resolved in `update()`, which the game calls once per frame.
 */
export class Input {
  private readonly el: HTMLElement;
  private readonly pointers = new Map<number, Pointer>();
  private readonly keys = new Set<string>();

  private layout: ControlLayout = {
    turbo: { x: 0, y: 0, r: 0 },
    action: { x: 0, y: 0, r: 0 },
    joystickZoneRight: 0,
  };

  // Resolved intent (read by game code).
  readonly move: Vec2 = { x: 0, y: 0 };
  joystickActive = false;
  readonly joystickOrigin: Vec2 = { x: 0, y: 0 };
  readonly joystickKnob: Vec2 = { x: 0, y: 0 };

  turbo = false;
  action = false;
  actionPressed = false;
  actionReleased = false;
  /** Edge + timing for double-tap (spin/juke) detection. */
  private lastActionDownTime = -1;
  doubleTapped = false;

  private prevAction = false;
  private joystickPointerId: number | null = null;

  private pendingTaps: Vec2[] = [];

  constructor(el: HTMLElement) {
    this.el = el;
    this.attach();
  }

  setLayout(layout: ControlLayout): void {
    this.layout = layout;
  }

  private attach(): void {
    const el = this.el;
    el.addEventListener("pointerdown", this.onDown, { passive: false });
    el.addEventListener("pointermove", this.onMove, { passive: false });
    el.addEventListener("pointerup", this.onUp, { passive: false });
    el.addEventListener("pointercancel", this.onUp, { passive: false });
    window.addEventListener("keydown", this.onKey);
    window.addEventListener("keyup", this.onKeyUp);
    // Prevent context menu on long-press.
    el.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  private localPos(e: PointerEvent): { x: number; y: number } {
    const rect = this.el.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private inCircle(p: { x: number; y: number }, c: CircleRegion): boolean {
    return Math.hypot(p.x - c.x, p.y - c.y) <= c.r;
  }

  private onDown = (e: PointerEvent): void => {
    e.preventDefault();
    this.el.setPointerCapture?.(e.pointerId);
    const p = this.localPos(e);
    let role: Pointer["role"] = "tap";
    if (this.inCircle(p, this.layout.turbo)) role = "turbo";
    else if (this.inCircle(p, this.layout.action)) role = "action";
    else if (p.x <= this.layout.joystickZoneRight && this.joystickPointerId === null) {
      role = "joystick";
      this.joystickPointerId = e.pointerId;
      this.joystickOrigin.x = p.x;
      this.joystickOrigin.y = p.y;
    }
    this.pointers.set(e.pointerId, {
      id: e.pointerId,
      x: p.x,
      y: p.y,
      startX: p.x,
      startY: p.y,
      startTime: performance.now(),
      role,
      moved: false,
    });
  };

  private onMove = (e: PointerEvent): void => {
    const ptr = this.pointers.get(e.pointerId);
    if (!ptr) return;
    e.preventDefault();
    const p = this.localPos(e);
    ptr.x = p.x;
    ptr.y = p.y;
    if (Math.hypot(p.x - ptr.startX, p.y - ptr.startY) > 8) ptr.moved = true;
  };

  private onUp = (e: PointerEvent): void => {
    const ptr = this.pointers.get(e.pointerId);
    if (!ptr) return;
    e.preventDefault();
    // Quick, low-movement touches register as taps for menu/UI.
    const dt = performance.now() - ptr.startTime;
    if (!ptr.moved && dt < 400) {
      this.pendingTaps.push({ x: ptr.x, y: ptr.y });
    }
    if (this.joystickPointerId === e.pointerId) {
      this.joystickPointerId = null;
      this.joystickActive = false;
    }
    this.pointers.delete(e.pointerId);
  };

  private onKey = (e: KeyboardEvent): void => {
    // Avoid hijacking browser shortcuts with modifier keys held.
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    this.keys.add(e.key.toLowerCase());
    if ([" ", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(e.key.toLowerCase())) {
      e.preventDefault();
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.key.toLowerCase());
  };

  /** Resolve intent for this frame. Call once per frame, before game logic reads input. */
  update(): void {
    // --- joystick / keyboard movement ---
    let mx = 0;
    let my = 0;
    this.joystickActive = false;
    if (this.joystickPointerId !== null) {
      const ptr = this.pointers.get(this.joystickPointerId);
      if (ptr) {
        this.joystickActive = true;
        let dx = ptr.x - this.joystickOrigin.x;
        let dy = ptr.y - this.joystickOrigin.y;
        const d = Math.hypot(dx, dy);
        if (d > JOYSTICK_RADIUS) {
          dx = (dx / d) * JOYSTICK_RADIUS;
          dy = (dy / d) * JOYSTICK_RADIUS;
        }
        this.joystickKnob.x = this.joystickOrigin.x + dx;
        this.joystickKnob.y = this.joystickOrigin.y + dy;
        mx = dx / JOYSTICK_RADIUS;
        my = dy / JOYSTICK_RADIUS;
      }
    }

    if (!this.joystickActive) {
      if (this.keys.has("a") || this.keys.has("arrowleft")) mx -= 1;
      if (this.keys.has("d") || this.keys.has("arrowright")) mx += 1;
      if (this.keys.has("w") || this.keys.has("arrowup")) my -= 1;
      if (this.keys.has("s") || this.keys.has("arrowdown")) my += 1;
      const n = normalize({ x: mx, y: my });
      mx = n.x;
      my = n.y;
    }
    this.move.x = clamp(mx, -1, 1);
    this.move.y = clamp(my, -1, 1);

    // --- buttons ---
    let turboDown = this.keys.has("shift");
    let actionDown = this.keys.has(" ") || this.keys.has("j") || this.keys.has("k");
    for (const ptr of this.pointers.values()) {
      if (ptr.role === "turbo") turboDown = true;
      if (ptr.role === "action") actionDown = true;
    }
    this.turbo = turboDown;
    this.action = actionDown;
    this.actionPressed = actionDown && !this.prevAction;
    this.actionReleased = !actionDown && this.prevAction;

    this.doubleTapped = false;
    if (this.actionPressed) {
      const now = performance.now();
      if (this.lastActionDownTime >= 0 && now - this.lastActionDownTime < 280) {
        this.doubleTapped = true;
      }
      this.lastActionDownTime = now;
    }

    this.prevAction = actionDown;
  }

  /** Pull and clear taps accumulated since the last call (used by menus). */
  consumeTaps(): Vec2[] {
    if (this.pendingTaps.length === 0) return [];
    const t = this.pendingTaps;
    this.pendingTaps = [];
    return t;
  }

  isKeyDown(k: string): boolean {
    return this.keys.has(k.toLowerCase());
  }
}
