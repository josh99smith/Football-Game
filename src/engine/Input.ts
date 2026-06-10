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
  /** Secondary action (juke / dive-tackle). */
  action2: CircleRegion;
  /** Fixed d-pad base — the joystick deflects from this anchor. */
  joystick: CircleRegion;
  /** The right action stick: push = carrier moves, tap/hold = the contextual action (snap/throw/etc). */
  rightStick: CircleRegion;
  /** Pointers starting left of this screen X drive the joystick. */
  joystickZoneRight: number;
}

interface Pointer {
  id: number;
  x: number;
  y: number;
  startX: number;
  startY: number;
  startTime: number;
  role: "joystick" | "rstick" | "turbo" | "action" | "action2" | "tap";
  moved: boolean;
}

/**
 * Unified input: merges touch (a fixed d-pad + three action buttons) and keyboard
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
    action2: { x: 0, y: 0, r: 0 },
    joystick: { x: 0, y: 0, r: 56 },
    rightStick: { x: 0, y: 0, r: 56 },
    joystickZoneRight: 0,
  };

  // Resolved intent (read by game code).
  readonly move: Vec2 = { x: 0, y: 0 };
  joystickActive = false;
  readonly joystickOrigin: Vec2 = { x: 0, y: 0 };
  readonly joystickKnob: Vec2 = { x: 0, y: 0 };

  // Right action stick (for rendering): live deflection + knob.
  rightStickActive = false;
  readonly rightStick: Vec2 = { x: 0, y: 0 };
  readonly rightStickKnob: Vec2 = { x: 0, y: 0 };
  private readonly rightStickOrigin: Vec2 = { x: 0, y: 0 };
  private rightStickPointerId: number | null = null;
  /** True once a press has pushed past the move threshold (so it's a move, not a tap action). */
  private rstickFiredMove = false;

  turbo = false;
  action = false;
  actionPressed = false;
  actionReleased = false;
  action2 = false;
  action2Pressed = false;
  doubleTapped = false;

  private prevAction = false;
  private prevAction2 = false;
  private prevR = false;
  private prevF = false;
  private lastActionDownTime = -1;
  private joystickPointerId: number | null = null;
  private pendingTaps: Vec2[] = [];
  /** A quick directional flick (off the joystick + buttons), consumed by carrier moves. */
  private pendingSwipe: Vec2 | null = null;

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
    else if (this.inCircle(p, this.layout.action2)) role = "action2";
    else if (this.inCircle(p, this.layout.rightStick) && this.rightStickPointerId === null) {
      role = "rstick";
      this.rightStickPointerId = e.pointerId;
      this.rightStickOrigin.x = this.layout.rightStick.x; // fixed-base: push from the anchor
      this.rightStickOrigin.y = this.layout.rightStick.y;
      this.rstickFiredMove = false;
    } else if (p.x <= this.layout.joystickZoneRight && this.joystickPointerId === null) {
      role = "joystick";
      this.joystickPointerId = e.pointerId;
      // Fixed-base d-pad: deflect from the anchor, not the touch point.
      this.joystickOrigin.x = this.layout.joystick.x;
      this.joystickOrigin.y = this.layout.joystick.y;
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
    const dt = performance.now() - ptr.startTime;
    if (!ptr.moved && dt < 400) this.pendingTaps.push({ x: ptr.x, y: ptr.y });
    // A fast directional flick that isn't the joystick or a button press is a swipe (carrier moves:
    // left/right = juke, downfield = truck). The joystick lives in the left half, so swipes are the
    // right thumb.
    const sdx = ptr.x - ptr.startX;
    const sdy = ptr.y - ptr.startY;
    const sdist = Math.hypot(sdx, sdy);
    // A swipe is a quick directional flick: a right-side flick (role "tap") OR a hard flick of the
    // movement stick (role "joystick", needs a bigger throw so a normal nudge isn't a juke). Holding
    // the stick to run has a long dt, so it never counts.
    const minDist = ptr.role === "joystick" ? 52 : 34;
    if ((ptr.role === "tap" || ptr.role === "joystick") && dt < 300 && sdist > minDist) {
      this.pendingSwipe = { x: sdx / sdist, y: sdy / sdist };
    }
    if (this.joystickPointerId === e.pointerId) {
      this.joystickPointerId = null;
      this.joystickActive = false;
    }
    if (this.rightStickPointerId === e.pointerId) {
      this.rightStickPointerId = null;
      this.rightStickActive = false;
    }
    this.pointers.delete(e.pointerId);
  };

  private onKey = (e: KeyboardEvent): void => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    this.keys.add(e.key.toLowerCase());
    if ([" ", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(e.key.toLowerCase())) {
      e.preventDefault();
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.key.toLowerCase());
  };

  /** Live position of a currently-held pointer (any), or null — used for dragging UI like the
   *  replay scrub slider. */
  drag: Vec2 | null = null;

  /** Resolve intent for this frame. Call once per frame, before game logic reads input. */
  update(): void {
    // Surface any held pointer's live position for drag UI.
    this.drag = null;
    for (const ptr of this.pointers.values()) { this.drag = { x: ptr.x, y: ptr.y }; break; }

    const R = this.layout.joystick.r || 56;
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
        if (d > R) {
          dx = (dx / d) * R;
          dy = (dy / d) * R;
        }
        this.joystickKnob.x = this.joystickOrigin.x + dx;
        this.joystickKnob.y = this.joystickOrigin.y + dy;
        mx = dx / R;
        my = dy / R;
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

    // --- right action stick: a directional PUSH fires a one-shot carrier move (up=truck, L/R=juke,
    // down=back-juke). It is MOVES-ONLY now — the contextual action (snap/throw/tackle) lives on its
    // own dedicated ACTION button so the two never conflict.
    this.rightStickActive = false;
    if (this.rightStickPointerId !== null) {
      const ptr = this.pointers.get(this.rightStickPointerId);
      if (ptr) {
        this.rightStickActive = true;
        const RR = this.layout.rightStick.r || 56;
        const dx = ptr.x - this.rightStickOrigin.x;
        const dy = ptr.y - this.rightStickOrigin.y;
        const d = Math.hypot(dx, dy);
        const cl = d > RR ? RR / d : 1;
        this.rightStickKnob.x = this.rightStickOrigin.x + dx * cl;
        this.rightStickKnob.y = this.rightStickOrigin.y + dy * cl;
        this.rightStick.x = (dx * cl) / RR;
        this.rightStick.y = (dy * cl) / RR;
        if (!this.rstickFiredMove && d > RR * 0.6) {
          this.pendingSwipe = Math.abs(dx) >= Math.abs(dy)
            ? { x: Math.sign(dx), y: 0 }
            : { x: 0, y: Math.sign(dy) };
          this.rstickFiredMove = true; // fired this push's move (once)
        }
      }
    }
    if (!this.rightStickActive) { this.rightStick.x = 0; this.rightStick.y = 0; }

    // --- buttons ---
    let turboDown = this.keys.has("shift");
    let actionDown = this.keys.has(" ") || this.keys.has("j");
    let action2Down = this.keys.has("k");
    for (const ptr of this.pointers.values()) {
      if (ptr.role === "turbo") turboDown = true;
      if (ptr.role === "action") actionDown = true;
      if (ptr.role === "action2") action2Down = true;
    }
    this.turbo = turboDown;
    this.action = actionDown;
    this.actionPressed = actionDown && !this.prevAction;
    this.actionReleased = !actionDown && this.prevAction;
    this.action2 = action2Down;
    this.action2Pressed = action2Down && !this.prevAction2;

    this.doubleTapped = false;
    if (this.actionPressed) {
      const now = performance.now();
      if (this.lastActionDownTime >= 0 && now - this.lastActionDownTime < 280) this.doubleTapped = true;
      this.lastActionDownTime = now;
    }

    this.prevAction = actionDown;
    this.prevAction2 = action2Down;

    // Keyboard ACTION stick (desktop): F (or R) flicks UP to DIVE — fired as an up-swipe on the key's
    // leading edge, the same signal the right stick emits.
    const rK = this.keys.has("r"), fK = this.keys.has("f");
    if ((rK && !this.prevR) || (fK && !this.prevF)) this.pendingSwipe = { x: 0, y: -1 };
    this.prevR = rK; this.prevF = fK;
  }

  consumeTaps(): Vec2[] {
    if (this.pendingTaps.length === 0) return [];
    const t = this.pendingTaps;
    this.pendingTaps = [];
    return t;
  }

  /** Take the latest swipe flick direction (screen-space unit vector) once, or null. */
  consumeSwipe(): Vec2 | null {
    const s = this.pendingSwipe;
    this.pendingSwipe = null;
    return s;
  }

  isKeyDown(k: string): boolean {
    return this.keys.has(k.toLowerCase());
  }
}
