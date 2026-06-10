import type { GameApp } from "../../engine/Game";
import type { GameState } from "../../engine/GameState";
import type { Renderer } from "../../engine/Renderer";
import { drawCrest, type EmblemIcon } from "../../ui/Emblems";
import { dist, lerp, clamp, moveToward, type Vec2 } from "../../engine/math/Vec2";
import { chance } from "../../engine/math/random";
import { Player } from "../entities/Player";
import { Ball } from "../entities/Ball";
import { buildDefense, buildOffense, type OffensePlay, type DefensePlay } from "../Playbook";
import { assignDefense, updateDefense, type PlayContext } from "../ai/DefenseAI";
import { updateOffense } from "../ai/OffenseAI";
import { CPUOffense, steerCarrier } from "../ai/CPUOffense";
import { chooseTarget, resolveAir } from "../Passing";
import { HUD } from "../../ui/HUD";
import { TouchControls, type ControlLabels } from "../../ui/TouchControls";
import { FONT, COLORS } from "../../ui/Theme";
import { drawPanel, drawButton, tappedIn, type Rect } from "../../ui/widgets";
import { ReplaySystem } from "../ReplaySystem";
import { FreeCamController } from "../../engine/FreeCamController";
import { TackleEngine, type GangTackle, type TackleQuery } from "../TackleEngine";
import { LEFT_GOAL_X, RIGHT_GOAL_X, PX_PER_YARD } from "../Field";
import { TWO_POINT_POINTS } from "../Match";
import type { Match, PlayOutcome, OutcomeType } from "../Match";
import { PlayCallOverlay } from "../../ui/PlayCallOverlay";
import { cpuOffensePlay, cpuDefensePlay } from "../ai/PlayCaller";
import { KickoffState } from "./KickoffState";
import { GameOverState } from "./GameOverState";
import { PatChoiceState } from "./PatChoiceState";
import { FourthDownState } from "./FourthDownState";
import { MenuState } from "./MenuState";

type Phase = "presnap" | "live" | "dead" | "playcall" | "replay" | "struggle";

/** Config for a live kickoff / punt return: who's receiving and where they field the ball. */
export interface KickReturnSetup {
  receiver: "HOME" | "AWAY";
  ballX: number;
}

// Pre-snap is player-controlled now; this is only a safety fallback so a play can't
// hard-stall if the hike is never pressed.
const PRESNAP_TIME = 20;
const MAX_PLAY_TIME = 16;
/** Duration of the pre-snap broadcast camera sweep that settles behind the offense (s). */
const PRESNAP_CINE_DUR = 2.1;
/** How far onto the defense's side of the LOS a pre-snap defender must stay (px) — no offsides. */
const PRESNAP_LOS_MARGIN = 2;
/** Hard cap on the post-play beat so it can't hang if the player never taps. */
const POSTPLAY_MAX = 9;
/** Superstar camera pull-back behind the controlled player (world units): defense sits further back
 *  so you read the whole play developing; offense (QB) stays a touch tighter. */
const SS_BACK_DEF = 10.8;
const SS_BACK_OFF = 8.6;
/** Minimum post-play beat before a tap can skip to the play call (guarantees a post-play). */
const MIN_DEAD_LINGER = 0.7;
/** Farthest a pass can travel (yards) — a deep ball, not a 90-yard heave. */
const MAX_PASS_YARDS = 52;
// Tecmo-style tackle battle (quick-tap to break / make the tackle). The trigger chance lives in
// the tackling engine; these tune the battle itself.
const STRUGGLE_TIME = 2.6;   // seconds before it resolves on whoever's ahead
const STRUGGLE_TAP = 0.07;   // meter gained per mash
const STRUGGLE_CPU = 0.2;    // meter drift per second toward the CPU's side
/** Hold this long (s) to fully charge a bullet pass; a quick tap throws a lob. */
const THROW_CHARGE_MAX = 0.5;
/** Hold the ACTION button this long (s) as a ball carrier to dive instead of juke. */
const DIVE_HOLD = 0.22;
/** A defender within this distance (px) of the carrier tackles on ACTION (else switches). */
const DEF_TACKLE_RANGE = 70;

/** Map throw power (0 lob .. 1 bullet) to launch parameters. Single source of truth.
 * Lobs get an exaggerated, floaty arc; bullets are flat and fast with a tighter spiral. */
function throwParams(power: number): { speed: number; loft: number; spin: number } {
  const p = Math.max(0, Math.min(1, power));
  return { speed: lerp(290, 590, p), loft: lerp(2.9, 0.65, p), spin: lerp(24, 54, p) };
}
const DIFFICULTY = {
  // reactBase/reactRate control how fast the pass rush + pursuit ramp up after the
  // snap — lower = more time in the pocket and bigger running lanes.
  rookie: { pick: 0.12, cpuSpeed: 0.94, reactBase: 0.32, reactRate: 1.0 },
  pro: { pick: 0.24, cpuSpeed: 1.0, reactBase: 0.5, reactRate: 1.45 },
  allpro: { pick: 0.36, cpuSpeed: 1.05, reactBase: 0.62, reactRate: 1.8 },
};

/**
 * The heart of the game: simulates one play from snap to whistle. Handles human
 * control of the ball carrier (offense) or a defender (defense), AI for everyone
 * else, passing, blocking, tackling, big-hit juice, and end-of-play detection.
 */
export class LivePlayState implements GameState {
  private readonly app: GameApp;
  private offensePlay: OffensePlay; // re-armed each down from the play-call overlay
  private defensePlay: DefensePlay;

  private offense: Player[] = [];
  private defense: Player[] = [];
  private all: Player[] = [];
  private ball = new Ball();

  private phase: Phase = "presnap";
  /** Safety fallback so a play never hard-stalls in pre-snap. */
  private snapTimer = PRESNAP_TIME;
  /** Time left in the pre-snap cinematic camera sweep (counts down; 0 = hand back to follow). */
  private presnapCineT = 0;
  /** Throttle for the reactive crowd-intensity update (don't reschedule the ramp every frame). */
  private atmoT = 0;
  /** Whether the looping on-fire crackle ambience is currently playing. */
  private fireAmbOn = false;
  /** True once everyone has broken the huddle and reached their spot. */
  private preSnapReady = false;
  /** Countdown for the CPU offense to hike once set (defense games). */
  private cpuHikeTimer = -1;
  private playTime = 0;

  private dir = 1;
  private offenseTeamId: "HOME" | "AWAY" = "HOME";
  private humanIsOffense = true;
  private controlled: Player | null = null;
  private qb: Player | null = null;

  private cpu: CPUOffense;
  private hud = new HUD();
  private controls = new TouchControls();

  private turbo = 1; // 0..1 meter for the controlled player
  /** Throw charge (seconds ACTION held); maps tap->lob, hold->bullet. */
  private throwCharge = 0;
  private throwCharging = false;
  /** Ball-carrier ACTION hold tracking (tap = juke, hold = dive). */
  private carrierHeld = 0;
  private carrierFired = false;
  /** Cooldown so the change-of-direction "juke" animation fires on a hard cut, not every frame. */
  private jukeAnimCd = 0;
  private startLosX = 0;
  private passThrown = false;
  private sackPossible = true;
  /** The receiver the current pass is aimed at (attacks the ball in flight). */
  private passTarget: Player | null = null;
  /** Post-whistle beat so the player SEES the catch/tackle before the result banner. */
  private pendingOutcome: PlayOutcome | null = null;
  /** Applied-outcome result (drives the on-field result banner + routing). */
  private playResult: ReturnType<Match["applyOutcome"]> | null = null;
  /** Secondary line under the result headline (FIRST DOWN! / TURNOVER! / down & dist). */
  private resultDetail = "";
  /** Minimum settle/celebration time before players regroup toward the huddle. */
  private deadTimer = 0;
  /** Total time spent post-whistle (drives the regroup + the hard auto-advance). */
  private deadElapsed = 0;
  /** Where each player ambles back to during the post-play regroup (lazy). */
  private regroupTargets: Map<Player, Vec2> | null = null;
  /** Players currently mid physics-ragdoll (indices into `all`); the whistle waits for them. */
  private ragdollIdx: number[] = [];
  /** Hold the post-play beat until the physics fall + get-up finishes. */
  private holdForRagdoll = false;
  /** Whether the play ended on a highlight-reel big hit (drives the auto instant replay). */
  private lastBigHit = false;
  /** Camera subject while a ragdoll tackle plays out (the ball carrier going down). */
  private ragdollFocus: Player | null = null;
  /** Ball spot the play ended at (anchors the regroup huddle). */
  private endSpot: Vec2 = { x: 0, y: 0 };
  /** Where the play finished (ball spot) — the camera subject during the post-play beat. */
  private deadFocus: Vec2 | null = null;
  /** Quarter / halftime break banner (text + seconds remaining). */
  private quarterBannerText = "";
  private quarterBannerT = 0;
  /** Cooldown between CPU big hits so the defense doesn't spam hit-sticks. */
  private cpuBigHitCd = 0;
  /** 1-on-1 tackle battle (mash to break / make the tackle). */
  private struggleCarrier: Player | null = null;
  private struggleTackler: Player | null = null;
  private struggleVal = 0.5; // 0 = tackle made, 1 = carrier breaks free
  private struggleTimer = 0;
  private struggleHumanCarrier = false;
  private struggleCd = 0;    // cooldown so battles don't chain
  private struggleFlash = 0; // mash feedback pulse
  private struggleMid: Vec2 = { x: 0, y: 0 }; // locked center of the battle
  private struggleAng = 0;   // axis between the two
  private struggleHalf = 0;  // half the (tight) separation so the bodies actually touch
  /** Instant replay: records the play, then plays it back with scrub + zoom + ball-cam. */
  private readonly replay = new ReplaySystem();
  /** Free-look camera for the replay (orbit/pan/zoom), created lazily on first replay. */
  private freeCam: FreeCamController | null = null;
  private replayT = 0;          // current replay time (s)
  private replayLastIdx = -1;   // last sampled frame, to detect a scrub/rewind jump
  private replayPlaying = true;
  private replayZoom = 0.45;    // 0 wide .. 1 tight
  private replayFrom: Phase = "dead"; // phase to return to when the replay closes
  private replayAuto = false;   // true = an automatic broadcast replay (touchdown), not user-opened
  private autoReplayDone = false; // only auto-roll the broadcast replay once per play
  private replaySpeed = 1;      // playback rate (auto replays roll in slow-mo)
  private replayHold = 0;       // post-playback hold before an auto replay closes itself
  /** 0..1 cinematic letterbox coverage, eased in during replay for a broadcast cut. */
  private letterbox = 0;
  // UI hit-rects (set in render, read in update — one-frame lag is fine).
  private replayBtn: Rect = { x: 0, y: 0, w: 0, h: 0 };
  /** Practice-only "EXIT" button (back to the menu), shown during the between-downs play-call. */
  private practiceExitRect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private rcClose: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private rcPlay: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private rcZoomIn: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private rcZoomOut: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private rcSlider: Rect = { x: 0, y: 0, w: 0, h: 0 };
  /** Whether the game clock keeps running between plays (after an inbounds run/tackle) — it
   *  stops on incompletions, out-of-bounds, scores and turnovers, just like real football. */
  private clockRunning = false;
  /** A live turnover return is underway (the AI roles are flipped; the defense escorts/runs). */
  private isReturn = false;
  private returnFor: "HOME" | "AWAY" | null = null;
  private returnKind: "interception" | "fumble" | "kick" = "interception";
  /** When set, this state launches a live kickoff/punt return instead of a scrimmage down. */
  private kickReturnSetup: KickReturnSetup | null = null;
  /** This series is a two-point conversion try (one goal-line snap, TD = 2 pts, then kickoff). */
  private twoPoint = false;
  private twoPointTeam: "HOME" | "AWAY" = "HOME";
  /** True once the chase camera has been hard-placed; later downs ease instead of cutting. */
  private cameraPrimed = false;
  /** A fumble is on the ground, live, waiting to be recovered. */
  private looseBall = false;
  private looseTimer = 0;
  /** Broadcast play-call overlay shown over the live field between downs, with fade-in. */
  private playCall = new PlayCallOverlay();
  private playCallT = 0;
  /** A tackle is wrapping up; endPlay fires when this timer elapses (the contact beat). */
  private pendingTackle: { type: OutcomeType; spot: Vec2 } | null = null;
  private pendingTackleTimer = 0;

  private readonly tackle: TackleEngine;

  constructor(app: GameApp, offensePlay: OffensePlay, defensePlay: DefensePlay, kickReturn?: KickReturnSetup) {
    this.app = app;
    this.offensePlay = offensePlay;
    this.defensePlay = defensePlay;
    this.kickReturnSetup = kickReturn ?? null;
    this.cpu = new CPUOffense(app.match.difficulty);
    this.tackle = new TackleEngine(app);
  }

  enter(): void {
    // Persistent, once-per-state-lifetime setup. This state now lives across the whole drive:
    // it stays mounted through the between-downs play-call overlay and re-arms each play in
    // place (so the 3D field keeps living behind the broadcast-style call), instead of bouncing
    // out to a separate play-select screen.
    this.app.scene3d.setVisible(true);
    this.app.scene3d.ensurePhysics(); // warm up the ragdoll physics WASM now (lazy, off the startup path)
    this.app.input.setLayout(this.controls.computeLayout(this.app.r, this.app.match.debugMode));
    this.app.audio.startCrowd();
    this.twoPoint = this.app.match.twoPointActive; // a goal-line two-point try
    this.twoPointTeam = this.app.match.possession;
    if (import.meta.env.DEV) (window as unknown as { __live: LivePlayState }).__live = this;
    if (this.kickReturnSetup) this.armKickReturn(this.kickReturnSetup);
    else this.armPlay(this.offensePlay, this.defensePlay);
  }

  /**
   * Build a live kickoff / punt return: the receiving team fields the ball with a returner +
   * a wall of blockers, the kicking team sprints down in coverage. It starts live (no snap) and
   * reuses the whole carrier/pursuit/tackle pipeline — a tackle spots the ball for the receiving
   * team's drive, breaking it to the house is a return touchdown.
   */
  private armKickReturn(setup: KickReturnSetup): void {
    const m = this.app.match;
    const receiver = setup.receiver;
    const kicking = m.opponent(receiver);
    this.offenseTeamId = receiver;
    this.humanIsOffense = receiver === m.humanTeam;
    this.dir = m.attackDir(receiver);
    const cy = this.app.field.maxY / 2;
    const ballX = setup.ballX;
    this.startLosX = ballX;
    // Park the yard markers on the spot so there's no stray line at midfield during the return.
    m.losX = ballX;
    m.firstDownX = ballX;

    // Returner + blockers (the receiving team) and the coverage unit (the kicking team).
    const returner = new Player(receiver, "HB", 28, ballX, cy);
    returner.job = "run";
    const blockers: Player[] = [];
    const bl = [-14, -6, 2, 10];
    bl.forEach((latYd, i) => {
      const b = new Player(receiver, i % 2 === 0 ? "WR" : "OL", 80 + i, ballX + this.dir * (10 + i * 4) * PX_PER_YARD, cy + latYd * PX_PER_YARD);
      b.job = "block";
      blockers.push(b);
    });
    const cover: Player[] = [];
    const cl = [-18, -9, 0, 9, 18];
    cl.forEach((latYd, i) => {
      const c = new Player(kicking, i === 2 ? "LB" : "DB", 20 + i, ballX + this.dir * (26 + (i % 2) * 8) * PX_PER_YARD, cy + latYd * PX_PER_YARD);
      cover.push(c);
    });

    this.offense = [returner, ...blockers];
    this.defense = cover;
    this.all = [...this.offense, ...this.defense];
    for (let i = 0; i < this.all.length; i++) this.all[i].simIndex = i;
    for (const p of this.all) { p.home = { x: p.pos.x, y: p.pos.y }; p.facing = p.team === receiver ? (this.dir > 0 ? 0 : Math.PI) : (this.dir > 0 ? Math.PI : 0); p.heading = p.facing; }
    this.qb = null;
    this.ball.attachTo(returner);

    this.resetPerPlay();
    // Override the scrimmage defaults: this is a live return from frame one.
    this.phase = "live";
    this.isReturn = true;
    this.returnFor = receiver;
    this.returnKind = "kick";
    this.passThrown = true;
    this.sackPossible = false;
    this.snapTimer = 0;
    this.clockRunning = true; // the clock starts the moment the returner fields the kick

    if (this.controlled) this.controlled.controlled = false;
    this.controlled = this.humanIsOffense ? returner : this.nearestDefenderToBall();
    if (this.controlled) this.controlled.controlled = true;

    this.app.scene3d.resetAvatars();
    this.app.scene3d.snapCamera(returner.pos.x, returner.pos.y, this.dir);
    this.cameraPrimed = true;
    this.app.audio.whistle();
  }

  /** Build a fresh down for the given call against the current match state, then go pre-snap.
   *  Called on entry and again for every subsequent play picked from the overlay. */
  private armPlay(offensePlay: OffensePlay, defensePlay: DefensePlay): void {
    const m = this.app.match;
    this.offensePlay = offensePlay;
    this.defensePlay = defensePlay;
    this.offenseTeamId = m.possession;
    this.humanIsOffense = m.possession === m.humanTeam;
    this.dir = m.attackDir(this.offenseTeamId);
    this.startLosX = m.losX;

    const defTeamId = m.opponent(this.offenseTeamId);
    this.offense = buildOffense(this.offensePlay, this.offenseTeamId, m.losX, this.dir);
    this.defense = buildDefense(defTeamId, m.losX, this.dir);
    this.all = [...this.offense, ...this.defense];
    for (let i = 0; i < this.all.length; i++) this.all[i].simIndex = i;
    this.qb = this.offense.find((p) => p.role === "QB") ?? null;

    // Ball starts with the QB.
    if (this.qb) this.ball.attachTo(this.qb);

    const ctx = this.context();
    assignDefense(ctx, this.defensePlay.scheme);

    // Choose who the human controls.
    if (this.controlled) this.controlled.controlled = false;
    this.controlled = this.humanIsOffense ? this.qb : this.nearestDefenderToBall();
    if (this.controlled) this.controlled.controlled = true;

    this.resetPerPlay();

    // Break the huddle: scatter players off their spots so they walk to the line.
    this.setupPreSnap();

    this.app.scene3d.resetAvatars();
    if (this.qb) {
      // Hard-cut only on the first snap of a drive; between downs the pre-snap camera eases from
      // the huddle to the new line of scrimmage instead of jumping (a smoother broadcast feel).
      if (!this.cameraPrimed) { this.app.scene3d.snapCamera(this.qb.pos.x, this.qb.pos.y, this.dir); this.cameraPrimed = true; }
    }
    // Roll a short broadcast camera sweep that orbits the line and settles behind the offense.
    this.presnapCineT = PRESNAP_CINE_DUR;
  }

  /** Reset all per-play/down bookkeeping (shared by scrimmage downs and kick returns). */
  private resetPerPlay(): void {
    this.phase = "presnap";
    this.snapTimer = PRESNAP_TIME;
    this.preSnapReady = false;
    this.cpuHikeTimer = -1;
    this.playTime = 0;
    this.passThrown = false;
    this.passTarget = null;
    this.sackPossible = true;
    this.turbo = 1;
    this.pendingTackle = null;
    this.pendingTackleTimer = 0;
    this.pendingOutcome = null;
    this.playResult = null;
    this.committed = false;
    this.deadTimer = 0;
    this.deadElapsed = 0;
    this.regroupTargets = null;
    this.deadFocus = null;
    this.ragdollIdx = [];
    this.holdForRagdoll = false;
    this.ragdollFocus = null;
    this.lastBigHit = false;
    this.cpuBigHitCd = 0;
    this.struggleCd = 0;
    this.struggleCarrier = null;
    this.struggleTackler = null;
    this.autoReplayDone = false;
    this.replay.clear(); // start a fresh recording for this down
    this.cpu.reset(); // fresh QB read each down (the state persists across the drive)
    this.tackle.reset();
    this.isReturn = false;
    this.returnFor = null;
    this.looseBall = false;
    this.looseTimer = 0;
    // NOTE: `clockRunning` is deliberately NOT reset here. In real football the game clock keeps
    // running through the huddle and up to the next snap after an inbounds play; it only stops on
    // incompletions, out-of-bounds, scores, turnovers and the two-minute warning. The previous
    // play's endPlay sets it, and it must persist across re-arming the next down.
  }

  /** DEBUG overlay focus: the player whose live motion the tuning readouts report on. */
  debugSubject(): Player | null {
    return this.controlled ?? this.ball.carrier ?? null;
  }

  /** DEV-only: force the ball carrier to be tackled by the nearest defender (headless tests). */
  debugForceTackle(_big = true, hitStick = false): boolean {
    if (this.phase !== "live") return false;
    const carrier = this.ball.carrier ?? this.qb;
    if (!carrier) return false;
    let tackler: Player | null = null;
    let best = Infinity;
    for (const d of this.all) {
      if (d.team === carrier.team) continue;
      const dd = dist(d.pos, carrier.pos);
      if (dd < best) { best = dd; tackler = d; }
    }
    if (!tackler) return false;
    // Place the defender right on the carrier so the hit lands this frame.
    tackler.pos = { x: carrier.pos.x - 6, y: carrier.pos.y };
    if (hitStick) tackler.bigHitArmed = true;
    this.applyGangTackle(this.tackle.commitTackle(this.tackleQuery(carrier), tackler));
    return true;
  }

  private context(): PlayContext {
    return {
      offense: this.offense,
      defense: this.defense,
      ball: this.ball,
      qb: this.qb,
      carrier: this.ball.carrier,
      losX: this.startLosX,
      dir: this.dir,
      isRun: this.offensePlay.isRun,
    };
  }

  private nearestDefenderToBall(): Player | null {
    let best: Player | null = null;
    let bestD = Infinity;
    for (const d of this.defense) {
      const dd = dist(d.pos, this.ball.pos);
      if (dd < bestD) {
        bestD = dd;
        best = d;
      }
    }
    return best;
  }

  // --- update ---------------------------------------------------------------

  update(dt: number): void {
    const m = this.app.match;
    // Burn the ON FIRE meters down over time (good plays refuel them in gradePlay).
    m.home.update(dt);
    m.away.update(dt);
    if (this.quarterBannerT > 0) this.quarterBannerT -= dt;
    // Cinematic letterbox slides in for the instant replay and back out when it closes.
    this.letterbox = moveToward(this.letterbox, this.phase === "replay" ? 1 : 0, dt / 0.28);

    if (this.phase === "presnap") {
      this.updatePreSnap(dt);
      return;
    }
    if (this.phase === "dead") {
      this.updateDeadBeat(dt);
      return;
    }
    if (this.phase === "playcall") {
      this.updatePlayCall(dt);
      return;
    }
    if (this.phase === "replay") {
      this.updateReplay(dt);
      return;
    }
    if (this.phase === "struggle") {
      this.updateStruggle(dt);
      return;
    }

    this.playTime += dt;
    m.tickClock(dt);
    if (this.struggleCd > 0) this.struggleCd -= dt;

    const ctx = this.context();
    this.handleHumanControl(dt);

    // AI for everyone not under human control.
    updateOffense(ctx, this.controlled);
    if (!this.humanIsOffense) {
      this.cpu.update(ctx, (from, target, receiver, power) => this.throwPass(from, target, receiver, power));
    }
    updateDefense(ctx, this.controlled);
    // Superstar (or any moment the human offense isn't the one carrying): the ball carrier — a caught
    // receiver, or a handed-off back while you're locked to the QB — has NO driver, because OffenseAI
    // skips the carrier and the CPU offense brain is off while the human has possession. Without this
    // he coasts on stale route momentum and can run the WRONG way (even through his own end zone).
    // Steer him as an open runner toward the correct goal (`ctx.dir`).
    if (this.humanIsOffense) {
      const carrier = this.ball.carrier;
      if (carrier && carrier !== this.controlled && carrier.team === this.offenseTeamId && !carrier.isDown) {
        steerCarrier(carrier, ctx);
      }
    }
    this.maybeCpuBigHit(dt);

    // While the ball is in the air, the target receiver attacks the catch point —
    // unless the human has taken control of them (then their input wins).
    if (
      this.ball.state === "inAir" &&
      this.passTarget &&
      !this.passTarget.isDown &&
      this.passTarget !== this.controlled
    ) {
      const t = this.ball.target;
      const p = this.passTarget;
      const dx = t.x - p.pos.x;
      const dy = t.y - p.pos.y;
      const d = Math.hypot(dx, dy) || 1;
      p.desired = { x: dx / d, y: dy / d };
      p.turbo = true;
    }

    // QB faces downfield while dropping back in the pocket (so the drop reads as a
    // backpedal); once he scrambles past the line or throws, he faces his movement.
    if (this.qb) {
      const behind = this.dir > 0 ? this.qb.pos.x < this.startLosX : this.qb.pos.x > this.startLosX;
      // Turbo in the backfield = tuck and scramble: drop the downfield pocket facing so he turns and
      // faces his movement → the forward RUN animation, instead of a downfield-facing backpedal.
      const scrambling = this.qb === this.controlled && this.qb.turbo;
      const inPocket = this.ball.carrier === this.qb && !this.passThrown && !this.offensePlay.isRun && behind && !scrambling;
      this.qb.lookDir = inPocket ? (this.dir > 0 ? 0 : Math.PI) : null;
    }

    // Apply on-fire flames at carriers' feet + a turbo speed trail.
    this.spawnFireFx();
    this.spawnTurboTrail();

    // Integrate movement.
    this.moveAll(dt);
    this.resolveBodies();
    this.checkJukeAnim(dt);

    // Ball + passing.
    const landed = this.ball.update(dt);
    if (this.ball.state === "inAir") {
      const f = this.app.field;
      const res = resolveAir(
        this.ball,
        this.offense,
        this.defense,
        landed,
        DIFFICULTY[m.difficulty].pick,
        { minX: f.minX, maxX: f.maxX, minY: f.minY, maxY: f.maxY },
        this.passTarget,
      );
      if (res) this.resolvePassResult(res);
    } else if (this.ball.state === "loose" && landed) {
      // (loose handled in tackle/fumble path)
    }

    // A tackle in progress wraps up over the contact beat, then the whistle blows.
    if (this.pendingTackle) {
      // Forward progress during the wrap-up can still break the plane (TD) or carry across a sideline
      // (out of bounds) — checkBoundaries was skipped here, so a runner wrapped at the 1 who slid in
      // got whistled down short. Re-check; if it ended the play, drop the scheduled whistle.
      this.checkBoundaries();
      if (this.phase !== "live") {
        this.pendingTackle = null;
      } else {
        this.pendingTackleTimer -= dt;
        if (this.pendingTackleTimer <= 0) {
          const pt = this.pendingTackle;
          this.pendingTackle = null;
          this.endPlay(pt.type, pt.spot);
        }
      }
    } else if (this.looseBall) {
      this.checkLooseBall();
    } else {
      this.checkTackles();
      this.checkBigHitWhiff();
      this.checkBoundaries();
    }

    if (this.playTime > MAX_PLAY_TIME && this.phase === "live" && !this.pendingTackle) {
      this.endPlay("tackle", this.ballSpot());
    }

    this.syncScene(dt);
  }

  /** Push the current sim state into the 3D scene (positions + camera). */
  private syncScene(dt: number): void {
    const m = this.app.match;
    this.trackRagdolls(); // glue ragdolling players to their physics hips before we frame them
    const busy = this.holdForRagdoll && this.app.scene3d.ragdollsBusy();
    // The camera ALWAYS follows the ball (held → carrier, in the air / loose → the ball itself).
    // The only exceptions are short cinematic beats that still frame the ball: the 1-on-1 battle,
    // the big-hit ragdoll close-up (clean tackle only — a fumble tracks the loose ball), and a
    // hold on the spot the play ended between downs.
    // Superstar camera is driven by phone orientation: hold the phone PORTRAIT to lock the tight
    // chase cam onto YOUR controlled player (experience the play through one guy); LANDSCAPE is the
    // normal broadcast view. Evaluated live, so rotating mid-play switches modes.
    const superstar = this.app.r.height > this.app.r.width;
    this.app.scene3d.superstarCam = superstar;
    let starFocus: Vec2 | null = null;
    let ssHeading: number | undefined;
    let ssLook: Vec2 | null = null;
    // DEFENSE superstar engages pre-snap AND holds through contact — it stays locked behind your
    // defender (no cut to the hit-cam when the carrier is tackled) and sits pulled back a bit more.
    // OFFENSE superstar is live-only, so the pre-snap stays the natural broadcast establish, and it
    // releases once your guy is down.
    const ssDefense = superstar && !this.humanIsOffense && !!this.controlled &&
      (this.phase === "live" || this.phase === "presnap");
    const ssOffense = superstar && this.humanIsOffense && !!this.controlled && !this.controlled.isDown &&
      this.phase === "live";
    this.app.scene3d.holdSuperstarThroughHit = ssDefense;
    if (ssDefense) {
      const c = this.controlled!;
      this.app.scene3d.superstarBack = SS_BACK_DEF;
      // Lock BEHIND the selected defender, framing the play. His own facing thrashes (backpedal,
      // react, pursue, juke), so orient by the steadier defender→ball vector instead. Held even while
      // he's in contact/down so the view doesn't cut on a tackle.
      starFocus = c.pos;
      const bx = this.ball.carrier ? this.ball.carrier.pos.x : this.ball.pos.x;
      const by = this.ball.carrier ? this.ball.carrier.pos.y : this.ball.pos.y;
      const dx = bx - c.pos.x, dy = by - c.pos.y;
      if (Math.hypot(dx, dy) > 14) { ssHeading = Math.atan2(dy, dx); ssLook = { x: bx, y: by }; }
      // else: too close to derive a stable heading — leave ssHeading undefined so Scene3D holds it.
    } else if (ssOffense) {
      const c = this.controlled!;
      this.app.scene3d.superstarBack = SS_BACK_OFF;
      const threw = this.passThrown && this.ball.thrownBy === c;
      if (threw) {
        // You're locked to the QB but watch the throw: ride behind the receiver once he catches it,
        // else look downfield at the ball in flight.
        ssHeading = c.heading;
        const carrier = this.ball.carrier;
        if (carrier && !carrier.isDown) { starFocus = carrier.pos; ssHeading = carrier.heading; }
        else { starFocus = this.ball.pos; ssLook = { x: this.ball.pos.x, y: this.ball.pos.y }; }
      } else {
        ssHeading = c.heading; // cam behind the QB looking downfield
        starFocus = c.pos;
        if (this.canThrow(c)) {
          const rcv = this.aimedReceiver(c); // QB: pan toward the receiver you're aiming at
          if (rcv) ssLook = { x: rcv.pos.x, y: rcv.pos.y };
        }
      }
    }

    const ballFocus = this.ball.carrier ? this.ball.carrier.pos : this.ball.pos;
    const focus = starFocus ? starFocus : this.phase === "struggle" && this.struggleCarrier && this.struggleTackler
      ? { x: (this.struggleCarrier.pos.x + this.struggleTackler.pos.x) / 2, y: (this.struggleCarrier.pos.y + this.struggleTackler.pos.y) / 2 }
      : busy && this.ragdollFocus && !this.looseBall
        ? this.ragdollFocus.pos // big-hit cinematic on the tackled ball-carrier
        : (this.phase === "dead" || this.phase === "playcall") && this.deadFocus
          ? this.deadFocus // hold where the play finished while the next call comes up
          : ballFocus;

    // Record the play for instant replay BEFORE sync — the avatar consumes (clears) animEvent, so
    // we must snapshot the one-shot (throw/catch/spin/tackle) first.
    if (this.phase === "live" || this.phase === "dead") {
      this.replay.record(this.all, this.ball, (p) => this.colorFor(p));
    }

    this.app.scene3d.sync({
      players: this.all,
      ball: this.ball,
      colorFor: (p) => this.colorFor(p),
      focusX: focus.x,
      focusY: focus.y,
      dir: this.dir,
      losX: this.startLosX,
      firstDownX: m.firstDownX,
      shakeX: this.app.shake.offsetX,
      shakeY: this.app.shake.offsetY,
      dt,
      ssHeading,
      ssLook,
    });

    this.updateAtmosphere(dt);
  }

  /**
   * Drive the living stadium: a crowd bed that swells with the stakes (red zone, close-and-late,
   * money downs, a team on fire) and a sustained fire-crackle ambience while anyone is ON FIRE.
   */
  private updateAtmosphere(dt: number): void {
    const m = this.app.match;
    const fire = m.home.onFire || m.away.onFire;

    // Fire ambience tracks the ON FIRE state (transition-gated so it isn't restarted every tick).
    if (fire && !this.fireAmbOn) { this.app.audio.startFire(); this.fireAmbOn = true; }
    else if (!fire && this.fireAmbOn) { this.app.audio.stopFire(); this.fireAmbOn = false; }

    // Crowd tension, refreshed a few times a second (each call reschedules a 1.1s glide).
    this.atmoT -= dt;
    if (this.atmoT > 0) return;
    this.atmoT = 0.3;
    const goalX = this.dir > 0 ? this.app.field.maxX : this.app.field.minX;
    const toGoalYd = Math.abs(goalX - m.losX) / PX_PER_YARD;
    let level = 0.22;
    if (toGoalYd <= 20) level += 0.3 * (1 - toGoalYd / 20) + 0.06; // red zone, building toward the goal
    if (m.quarter >= 4 && Math.abs(m.home.score - m.away.score) <= 8) level += 0.24; // close and late
    if (m.down >= 3) level += 0.12; // money down
    if (fire) level += 0.22;
    if (this.phase === "live") level += 0.06; // the ball is in play
    this.app.audio.setCrowdIntensity(level);
  }

  private colorFor(p: Player): { jersey: number; trim: number; accent: number; helmet: number; decal: EmblemIcon; onFire: boolean; defense: boolean } {
    const team = this.app.match.team(p.team);
    // Home club wears its colored kit; the road (AWAY) club wears its white set — the helmet shell
    // (and its decal/stripe) stays the same either way, as in the real game.
    const uni = p.team === "AWAY" ? team.config.away : team.config.colors;
    return {
      jersey: hexNum(uni.jersey),
      trim: hexNum(uni.trim),
      accent: hexNum(uni.accent),
      helmet: hexNum(team.config.helmet),
      decal: team.config.icon,
      onFire: team.onFire,
      defense: p.team !== this.offenseTeamId,
    };
  }

  /** Break the huddle: scatter players off their formation spots (which are stored in
   * p.home) so they walk to the line during pre-snap. */
  private setupPreSnap(): void {
    const cy = this.app.field.maxY / 2;
    const huddleX = this.startLosX - this.dir * PX_PER_YARD * 5;
    this.offense.forEach((p, i) => {
      if (p.role === "QB") {
        p.pos = { x: this.startLosX - this.dir * PX_PER_YARD * 4, y: cy };
      } else {
        const ang = (i / this.offense.length) * Math.PI * 2;
        p.pos = { x: huddleX + Math.cos(ang) * PX_PER_YARD * 1.6, y: cy + Math.sin(ang) * PX_PER_YARD * 1.6 };
      }
      p.vel.x = 0;
      p.vel.y = 0;
      this.faceTowardHome(p);
      p.lookDir = null;
    });
    // Defense jogs up to the line from a couple of yards downfield.
    for (const d of this.defense) {
      d.pos = { x: d.home.x + this.dir * PX_PER_YARD * 2.5, y: d.home.y };
      d.vel.x = 0;
      d.vel.y = 0;
      this.faceTowardHome(d);
      d.lookDir = null;
    }
  }

  /** Point a player at the spot they're about to walk to (so the break reads as a
   * clean forward jog instead of a sideways/backward shuffle while the heading catches up). */
  private faceTowardHome(p: Player): void {
    const dx = p.home.x - p.pos.x;
    const dy = p.home.y - p.pos.y;
    p.heading = Math.hypot(dx, dy) > 1 ? Math.atan2(dy, dx) : this.dir > 0 ? 0 : Math.PI;
  }

  /** Walk everyone from the huddle to their spots; the player decides when to hike. */
  private updatePreSnap(dt: number): void {
    let allSet = true;
    const human = !this.humanIsOffense ? this.controlled : null; // the defender the user is moving
    for (const p of this.all) {
      const isDef = p.team !== this.offenseTeamId;
      // Pre-snap, the user can shuffle their controlled defender around (disguise / shift) — but
      // not across the line of scrimmage (no jumping offsides), and not out of bounds. It doesn't
      // gate the snap, so the offense can still hike whenever it's set.
      if (p === human) {
        p.desired = this.stickToField();
        p.lookDir = null;
        p.step(dt, p.baseSpeed * 0.8, 2);
        p.pos.y = this.app.field.clampY(p.pos.y);
        const overLine = (p.pos.x - this.startLosX) * this.dir; // >0 on the defense's side
        if (overLine < PRESNAP_LOS_MARGIN) {
          p.pos.x = this.startLosX + this.dir * PRESNAP_LOS_MARGIN;
          p.vel.x = 0;
        }
        continue;
      }
      const dx = p.home.x - p.pos.x;
      const dy = p.home.y - p.pos.y;
      const d = Math.hypot(dx, dy);
      if (d > 6) {
        p.desired = { x: dx / d, y: dy / d };
        p.lookDir = null; // face the way they're walking
        // Brisk jog to the line — keep the break-the-huddle read but don't dawdle.
        p.step(dt, p.baseSpeed * 0.62);
        allSet = false;
      } else {
        // Arrived: hard-stop and set facing so the player stands cleanly in idle,
        // with no muddy decel tail or jitter around the mark.
        p.vel.x = 0;
        p.vel.y = 0;
        p.desired = { x: 0, y: 0 };
        // Settle facing: offense toward downfield, defense toward the offense.
        p.lookDir = isDef ? (this.dir > 0 ? Math.PI : 0) : (this.dir > 0 ? 0 : Math.PI);
        p.step(dt, 0);
      }
    }
    this.preSnapReady = allSet;

    if (this.humanIsOffense) {
      // Can't hike until the whole offense (and defense) is set on the line.
      if (this.app.input.actionPressed && allSet) this.snap();
    } else {
      // On defense, ACTION cycles which man you'll control; the CPU hikes once set.
      if (this.app.input.actionPressed) this.cycleDefender();
      if (allSet) {
        if (this.cpuHikeTimer < 0) this.cpuHikeTimer = 0.5 + Math.random() * 0.5;
        this.cpuHikeTimer -= dt;
        if (this.cpuHikeTimer <= 0) this.snap();
      }
    }

    // Safety fallback so the play can't hard-stall.
    this.snapTimer -= dt;
    if (this.snapTimer <= 0) this.snap();

    // A running clock (after an inbounds play) keeps ticking while the offense walks to the line
    // and waits for the snap — it doesn't freeze pre-snap.
    if (this.clockRunning) {
      this.app.match.tickClock(dt);
      this.applyTwoMinuteWarning();
    }
    // If the clock ran out while waiting to snap, end the period NOW — don't start another down at
    // 0:00. quarterBeat advances + resets the clock the same frame it expires (idempotent no-op
    // otherwise), so the next snap is in the fresh quarter rather than at a stale 0:00.
    this.quarterBeat();

    this.syncScene(dt); // sets superstarCam from the device orientation
    // Run the broadcast pre-snap establish EXCEPT in defensive superstar, where the lock cam owns the
    // pre-snap (already settled behind your defender). Offensive superstar keeps the natural establish
    // until the snap, then hands off to the QB lock.
    const defenseSuperstar = this.app.scene3d.superstarCam && !this.humanIsOffense;
    if (!defenseSuperstar) this.updatePresnapCine(dt);
  }

  /** A broadcast pre-snap sweep: the camera orbits in from a low side angle and settles behind the
   * offense at the gameplay over-the-shoulder pose, easing out so the snap hands off seamlessly to
   * the follow cam. Runs over the first ~2s of pre-snap (or until the ball is hiked). */
  private updatePresnapCine(dt: number): void {
    if (this.presnapCineT <= 0 || !this.qb) return;
    this.presnapCineT -= dt;
    const U = 1 / PX_PER_YARD;
    const p = clamp(1 - this.presnapCineT / PRESNAP_CINE_DUR, 0, 1);
    const e = p * p * (3 - 2 * p); // smoothstep toward the gameplay pose
    const fx = this.qb.pos.x * U;
    const fz = (this.app.field.maxY / 2) * U;
    // Orbit angle around the focus: end behind the offense (the follow pose), start swung ~120°
    // to the side; radius + height ease from a wide low establishing shot to the tight gameplay one.
    const endAng = Math.atan2(0, -this.dir);
    const ang = endAng - this.dir * 2.1 * (1 - e);
    const radius = lerp(15, 7.5, e);
    const height = lerp(2.2, 6.0, e);
    const camX = fx + Math.cos(ang) * radius;
    const camZ = fz + Math.sin(ang) * radius;
    const lookX = lerp(fx, fx + this.dir * 10, e);
    const lookY = lerp(1.5, 0.9, e);
    this.app.scene3d.dollyCam(camX, height, camZ, lookX, lookY, fz);
  }

  private snap(): void {
    this.phase = "live";
    this.clockRunning = true; // the clock always runs once the ball is snapped
    this.app.audio.snap();
    for (const p of this.all) p.lookDir = null; // hand facing back to AI/movement
    if (this.offensePlay.isRun) {
      // Immediate handoff to the back.
      const hb = this.offense.find((p) => p.role === "HB");
      if (hb && this.qb) {
        this.ball.attachTo(hb);
        if (this.humanIsOffense) {
          this.setControlled(hb);
        }
      }
    }
  }

  /** The stick mapped to a camera-relative FIELD direction. On screen field +X (downfield) is
   *  up and field +Y is right; the chase cam yaws 180° with `dir`. So rotate the raw stick
   *  (x=right, y=down) 90° and flip by `dir`: stick-up is always downfield-on-screen. */
  private stickToField(): Vec2 {
    const m = this.app.input.move;
    // Superstar DEFENSE: the cam sits BEHIND the defender looking back at the play (≈ opposite the
    // attack direction), so the dir-based map reads inverted. Map the stick relative to the camera's
    // actual eased forward instead — "up" always drives toward what you're looking at. (Broadcast and
    // the QB-superstar cam keep the stable dir-based map; their forward is already ≈ +dir.)
    if (this.app.scene3d.superstarCam && !this.humanIsOffense) {
      const fx = this.app.scene3d.superstarFwdX;
      const fy = this.app.scene3d.superstarFwdY;
      // field = (-m.y)·F + (m.x)·R, with screen-right R = (-Fy, Fx). Reduces to the dir-map when
      // F = (dir, 0), so this is the same construction generalized to any camera forward.
      return { x: -m.y * fx - m.x * fy, y: -m.y * fy + m.x * fx };
    }
    return { x: -m.y * this.dir, y: m.x * this.dir };
  }

  /** Superstar QB: the receiver currently being aimed at (the same one the throw would pick), so the
   *  camera can pan toward him. */
  private aimedReceiver(qb: Player): Player | null {
    const t = chooseTarget(qb, this.offense, this.defense, this.dir, this.stickToField());
    return t ? t.receiver : null;
  }

  private handleHumanControl(dt: number): void {
    const input = this.app.input;
    const c = this.controlled;

    if (!c || c.isDown) {
      // No live controlled player (e.g. ball in air). Defense switches to the nearest defender to the
      // ball; offense grabs the targeted receiver to go up for it. Disabled in superstar (locked).
      if (input.actionPressed && !this.app.scene3d.superstarCam) {
        if (!this.humanIsOffense) this.switchDefender();
        else if (this.ball.state === "inAir" && this.passTarget && !this.passTarget.isDown) {
          this.setControlled(this.passTarget);
        }
      }
      return;
    }

    // Movement, made camera-relative. On screen, field +X (downfield) is UP and field +Y is
    // RIGHT, and the chase cam yaws 180° with the attack direction. So the stick (x=right,
    // y=down) maps to the field rotated 90° and flipped by `dir`: stick-up = downfield, always.
    c.desired = this.stickToField();

    // Turbo meter management. ON FIRE gives the whole team near-unlimited turbo (drains slow,
    // recovers fast) — the payoff for stringing good plays together; otherwise it's a finite burst
    // that recharges when you let off.
    const onFire = this.app.match.team(c.team).onFire;
    const drain = onFire ? 0.12 : 0.46;
    const recharge = onFire ? 0.55 : 0.34;
    const wantTurbo = input.turbo && (input.move.x !== 0 || input.move.y !== 0);
    if (wantTurbo && this.turbo > 0.02) {
      c.turbo = true;
      this.turbo = Math.max(0, this.turbo - drain * dt);
    } else {
      c.turbo = false;
      this.turbo = Math.min(1, this.turbo + recharge * dt);
    }

    if (this.humanIsOffense) {
      // The one ACTION button is contextual: the QB (a legal passer behind the line)
      // charges a throw (tap = lob, hold = bullet); any ball carrier jukes/dives.
      if (this.canThrow(c)) {
        this.updateThrowCharge(c, dt);
      } else {
        this.throwCharging = false;
        this.throwCharge = 0;
        if (this.ball.carrier === c) this.updateCarrierAction(c, dt);
      }
    } else {
      this.handleDefenseAction(c);
    }
  }

  /** True when the controlled player is the QB and may legally throw (behind the line,
   * still holding the ball, on a pass play). */
  private canThrow(c: Player): boolean {
    const behind = this.dir > 0 ? c.pos.x <= this.startLosX + 4 : c.pos.x >= this.startLosX - 4;
    return (
      c === this.qb && this.ball.carrier === this.qb && !this.passThrown && !this.offensePlay.isRun && behind
    );
  }

  /** Charge a throw while ACTION is held; release into a lob (tap) -> bullet (hold). */
  private updateThrowCharge(qb: Player, dt: number): void {
    const input = this.app.input;
    // Begin a charge only on a FRESH press, so the held hike press (same button)
    // doesn't carry over into the first live frame and auto-throw a lob.
    if (input.actionPressed) {
      this.throwCharging = true;
      this.throwCharge = 0;
    }
    if (this.throwCharging && input.action) {
      this.throwCharge = Math.min(THROW_CHARGE_MAX, this.throwCharge + dt);
    }
    if (this.throwCharging && input.actionReleased) {
      const power = clamp(this.throwCharge / THROW_CHARGE_MAX, 0, 1);
      this.throwCharging = false;
      this.throwCharge = 0;
      const receivers = this.offense.filter((p) => p.role !== "QB");
      const choice = chooseTarget(qb, receivers, this.defense, this.dir, this.stickToField());
      if (choice) {
        const r = choice.receiver;
        // Lead the receiver by the resulting flight time so they run onto the ball.
        const speed = throwParams(power).speed;
        const flight = dist(qb.pos, r.pos) / speed;
        const lead = { x: r.pos.x + r.vel.x * flight * 0.9, y: r.pos.y + r.vel.y * flight * 0.9 };
        this.throwPass(qb, lead, r, power);
      }
    }
  }

  /** Play the change-of-direction "juke" animation whenever a ball carrier (human or CPU) cuts
   * hard while running. `loco.turnRate` is the body's heading-change rate; a sharp cut spikes it,
   * a gentle curve barely moves it. Gated by a short cooldown so the one-shot plays once per cut
   * rather than re-triggering every frame, and skipped if a bigger move (spin/dive) already fired. */
  private checkJukeAnim(dt: number): void {
    if (this.jukeAnimCd > 0) this.jukeAnimCd -= dt;
    const c = this.ball.carrier;
    if (!c || this.jukeAnimCd > 0) return;
    if (c.state !== "active" || c.animEvent !== null || c.jukeTimer > 0) return;
    if (c.loco.speed01 > 0.4 && Math.abs(c.loco.turnRate) > 6.5) {
      c.animEvent = "juke";
      this.jukeAnimCd = 0.7;
    }
  }

  /** Ball-carrier ACTION: a quick tap spins (spin move), holding past a beat dives. */
  private updateCarrierAction(c: Player, dt: number): void {
    const input = this.app.input;
    // Swipe moves: flick sideways to JUKE that way, flick forward (downfield) to lower the head and
    // TRUCK. Decompose the flick (mapped to field space like the stick) against the run direction.
    const sw = input.consumeSwipe();
    if (sw && c.state === "active" && c.animEvent === null && c.jukeTimer <= 0 && c.diveTimer <= 0) {
      const fx = -sw.y * this.dir;
      const fy = sw.x * this.dir;
      const fwd = Math.cos(c.facing) * fx + Math.sin(c.facing) * fy; // along the run direction
      const lat = Math.cos(c.facing) * fy - Math.sin(c.facing) * fx; // sideways component
      if (fwd > Math.abs(lat) && fwd > 0.3) this.doTruck(c);
      else this.doJuke(c, fx, fy);
      return;
    }
    if (input.actionPressed) {
      this.carrierHeld = 0;
      this.carrierFired = false;
    }
    if (input.action) {
      this.carrierHeld += dt;
      if (!this.carrierFired && this.carrierHeld >= DIVE_HOLD) {
        this.startDive(c);
        this.carrierFired = true;
      }
    }
    if (input.actionReleased && !this.carrierFired) {
      // Context move: fend off a defender squared up in front (STIFF ARM); otherwise SPIN.
      const d = this.nearestTackler(c, 72);
      if (d && this.isAhead(c, d)) this.doStiffArm(c, d);
      else this.doSpin(c);
      this.carrierFired = true;
    }
  }

  /** Nearest standing defender within `range` of the carrier. */
  private nearestTackler(c: Player, range: number): Player | null {
    let best: Player | null = null, bestD = range;
    for (const d of this.defense) {
      if (d.isDown) continue;
      const dd = dist(d.pos, c.pos);
      if (dd < bestD) { bestD = dd; best = d; }
    }
    return best;
  }

  /** Is `d` roughly in front of the carrier's run direction (within ~63°)? */
  private isAhead(c: Player, d: Player): boolean {
    const dx = d.pos.x - c.pos.x, dy = d.pos.y - c.pos.y, dl = Math.hypot(dx, dy) || 1;
    return (Math.cos(c.facing) * dx + Math.sin(c.facing) * dy) / dl > 0.45;
  }

  /** Stiff-arm: fend off the defender squared up in front — he's shoved aside and stumbles while
   * the carrier powers straight through with only a small loss of speed (no lateral curl, unlike a
   * spin). Brief immunity makes the tackle engine whiff that man. */
  private doStiffArm(c: Player, d: Player): void {
    c.jukeTimer = 0.22;
    const dx = d.pos.x - c.pos.x, dy = d.pos.y - c.pos.y, dl = Math.hypot(dx, dy) || 1;
    d.vel.x += (dx / dl) * 150; d.vel.y += (dy / dl) * 150;
    d.knockDown(0.55);
    c.vel.x *= 0.92; c.vel.y *= 0.92;
    const cross = Math.cos(c.facing) * (dy / dl) - Math.sin(c.facing) * (dx / dl);
    c.leanTarget = -Math.sign(cross) || 1;
    c.animEvent = "stiffArm";
    this.app.audio.juke();
    this.app.shake.add(0.12);
    this.app.particles.burst(d.pos.x, d.pos.y, "#ffffff", 7, 95);
    this.app.floating.add("STIFF ARM!", c.pos.x, c.pos.y - 24, { size: 18, color: "#cfe8d4", life: 0.8 });
  }

  /** Spin move: brief tackle-immunity + a burst that carries forward momentum through a 360°
   * spin, curling slightly to the aim side so the carrier spins OFF the defender. */
  private doSpin(c: Player): void {
    c.jukeTimer = 0.5; // immunity through the spin (the first tackler whiffs)
    const sp = Math.hypot(c.vel.x, c.vel.y);
    // Burst along the current run direction (keep the forward progress of a real spin move).
    if (sp > 30) {
      c.vel.x += (c.vel.x / sp) * 75;
      c.vel.y += (c.vel.y / sp) * 75;
    } else {
      c.vel.x += Math.cos(c.facing) * 60;
      c.vel.y += Math.sin(c.facing) * 60;
    }
    // Curl off toward the stick.
    const aim = this.stickToField();
    const am = Math.hypot(aim.x, aim.y);
    if (am > 0.3) {
      c.vel.x += (aim.x / am) * 34;
      c.vel.y += (aim.y / am) * 34;
      c.leanTarget = Math.sign(c.vel.x * (aim.y / am) - c.vel.y * (aim.x / am)) || 1;
    } else {
      c.leanTarget = 1;
    }
    c.animEvent = "spin";
    this.app.audio.juke();
    this.app.particles.burst(c.pos.x, c.pos.y, "#ffffff", 8, 90);
  }

  /**
   * Timing window for a swipe move, judged against the nearest threatening defender. A flick thrown
   * just as a defender closes into the sweet-spot distance (wider if he's committed to a dive/hit)
   * is "perfect"; close-but-not-quite is "good"; open field (no one near) is "normal". This is the
   * skill layer: read the defender and swipe on his commitment.
   */
  private swipeTiming(c: Player): { d: Player | null; q: "perfect" | "good" | "normal" } {
    let best: Player | null = null;
    let bestD = 95;
    for (const d of this.defense) {
      if (d.isDown) continue;
      const dd = dist(d.pos, c.pos);
      if (dd < bestD) { bestD = dd; best = d; }
    }
    if (!best) return { d: null, q: "normal" };
    const committed = best.diveTimer > 0 || best.bigHitArmed; // reading his commit widens the window
    const lo = committed ? 12 : 16;
    const hi = committed ? 66 : 48;
    if (bestD >= lo && bestD <= hi) return { d: best, q: "perfect" };
    if (bestD <= 82) return { d: best, q: "good" };
    return { d: best, q: "normal" };
  }

  /** Bowl a defender over: shove him off the carrier's line and put him on the ground. */
  private truckOver(c: Player, d: Player, downSec: number, shove: number): void {
    const dx = d.pos.x - c.pos.x, dy = d.pos.y - c.pos.y, dl = Math.hypot(dx, dy) || 1;
    d.vel.x += (dx / dl) * shove;
    d.vel.y += (dy / dl) * shove;
    d.knockDown(downSec);
  }

  /** Swipe juke: a sharp sidestep in the flick direction, with tackle immunity scaled by timing —
   *  a perfectly-timed cut leaves the closing defender grasping at air ("ANKLES!"). */
  private doJuke(c: Player, fx: number, fy: number): void {
    const { d, q } = this.swipeTiming(c);
    c.leanTarget = Math.sign(Math.cos(c.facing) * fy - Math.sin(c.facing) * fx) || 1; // bank into the cut
    c.animEvent = "juke";
    this.app.audio.juke();
    if (q === "perfect") {
      c.vel.x += fx * 175; c.vel.y += fy * 175;
      c.jukeTimer = 0.62; c.cutTimer = 0.6; // long immunity — he whiffs badly
      if (d) d.enterStumble(0.5); // the defender stutters past
      this.app.time.slow(0.5, 0.22); // a beat of slow-mo on the highlight cut
      this.app.particles.burst(c.pos.x, c.pos.y, "#9fe0ff", 10, 110);
      this.app.floating.add("ANKLES!", c.pos.x, c.pos.y - 26, { size: 20, color: "#9fe0ff", life: 0.9 });
      this.igniteCheck(c.team, 0.22);
    } else if (q === "good") {
      c.vel.x += fx * 140; c.vel.y += fy * 140;
      c.jukeTimer = 0.46; c.cutTimer = 0.45;
      this.app.particles.burst(c.pos.x, c.pos.y, "#ffffff", 7, 85);
      this.app.floating.add("JUKE!", c.pos.x, c.pos.y - 24, { size: 18, color: "#cfe8d4", life: 0.7 });
    } else {
      c.vel.x += fx * 112; c.vel.y += fy * 112;
      c.jukeTimer = 0.34; c.cutTimer = 0.38;
      this.app.particles.burst(c.pos.x, c.pos.y, "#ffffff", 5, 75);
      this.app.floating.add("JUKE!", c.pos.x, c.pos.y - 24, { size: 16, color: "#cfe8d4", life: 0.6 });
    }
  }

  /** Swipe-forward truck: lower the head and run through the defender. Timed on his commitment it's a
   *  devastating TRUCK STICK (flattens him + a second man, slow-mo, fire); mistimed you get stuffed. */
  private doTruck(c: Player): void {
    const tm = this.swipeTiming(c);
    const target = tm.d && this.isAhead(c, tm.d) ? tm.d : null;
    const q = target ? tm.q : "normal";
    const sp = Math.hypot(c.vel.x, c.vel.y);
    const fwx = sp > 30 ? c.vel.x / sp : Math.cos(c.facing);
    const fwy = sp > 30 ? c.vel.y / sp : Math.sin(c.facing);
    c.leanTarget = 0; // square + head down
    c.animEvent = "stiffArm"; // head-down power move (no dedicated truck clip)

    if (q === "perfect" && target) {
      c.vel.x += fwx * 150; c.vel.y += fwy * 150; // blow clean through, keep your feet moving
      c.jukeTimer = 0.55;
      this.truckOver(c, target, 1.1, 320); // flatten him
      // Gang truck: a second man crowding the hole gets bowled too.
      let d2: Player | null = null, d2d = 48;
      for (const dd of this.defense) {
        if (dd === target || dd.isDown) continue;
        const r = dist(dd.pos, c.pos);
        if (r < d2d) { d2d = r; d2 = dd; }
      }
      if (d2) this.truckOver(c, d2, 0.7, 210);
      this.app.audio.bigHit();
      this.app.shake.add(0.34);
      this.app.scene3d.hitZoom(0.5);
      this.app.time.slow(0.45, 0.32); // hit-stop on the truck
      this.app.particles.burst(target.pos.x, target.pos.y, "#ffd24a", 16, 150);
      this.app.floating.add("TRUCK STICK!", c.pos.x, c.pos.y - 26, { size: 22, color: "#ffd24a", life: 1.0 });
      this.igniteCheck(c.team, 0.34);
    } else if (q === "good" && target) {
      c.vel.x += fwx * 122; c.vel.y += fwy * 122;
      c.jukeTimer = 0.42;
      this.truckOver(c, target, 0.8, 240);
      c.vel.x *= 0.9; c.vel.y *= 0.9;
      this.app.audio.bigHit();
      this.app.shake.add(0.22);
      this.app.particles.burst(target.pos.x, target.pos.y, "#ffd24a", 11, 120);
      this.app.floating.add("TRUCK!", c.pos.x, c.pos.y - 24, { size: 20, color: "#ffd24a", life: 0.85 });
      this.igniteCheck(c.team, 0.14);
    } else if (target) {
      // Mistimed (swiped too early): you lower the head but don't square him up — bounce off and
      // lose steam, no knockdown. Read his commitment next time.
      c.vel.x += fwx * 70; c.vel.y += fwy * 70;
      c.vel.x *= 0.68; c.vel.y *= 0.68;
      c.jukeTimer = 0.16;
      this.app.audio.hit(0.6);
      this.app.shake.add(0.12);
      this.app.floating.add("STUFFED!", c.pos.x, c.pos.y - 22, { size: 16, color: "#d9b38c", life: 0.7 });
    } else {
      // Open field: a head-down power burst with nobody to run over.
      c.vel.x += fwx * 115; c.vel.y += fwy * 115;
      c.jukeTimer = 0.3;
      this.app.audio.juke();
      this.app.particles.burst(c.pos.x, c.pos.y, "#ffe2a6", 7, 90);
      this.app.floating.add("TRUCK!", c.pos.x, c.pos.y - 24, { size: 18, color: "#ffd24a", life: 0.7 });
    }
  }

  /** Defender ACTION is contextual: unleash a committed BIG HIT when near the carrier,
   * otherwise switch to the defender best placed to make the play. The big hit explodes
   * forward — connect for a devastating, fumble-forcing launch; whiff and you overcommit. */
  private handleDefenseAction(c: Player): void {
    if (!this.app.input.actionPressed) return;
    if (c.diveTimer > 0) return; // already committed to a lunge
    if (this.defenderInTackleRange(c)) {
      c.diveTimer = 0.3;
      c.bigHitArmed = true;
      c.animEvent = "dive"; // diving tackle lunge
      c.leanTarget = 0.7; // shoulder dips into the hit (the avatar banks)
      const burst = 165;
      c.vel.x += Math.cos(c.facing) * burst;
      c.vel.y += Math.sin(c.facing) * burst;
      this.app.particles.burst(c.pos.x, c.pos.y, "#dce6ff", 6, 80);
      this.app.shake.add(0.12);
    } else if (!this.app.scene3d.superstarCam) {
      this.switchDefender(); // no switching in superstar — you're locked to your defender for the play
    }
  }

  /** CPU defenders unleash the big hit too: a well-positioned, closing defender (not the one the
   *  human controls) occasionally commits a hit-stick on a ball-carrier in the open. Rate-limited
   *  by a difficulty-scaled cooldown so the field isn't a fumble lottery. */
  private maybeCpuBigHit(dt: number): void {
    if (this.cpuBigHitCd > 0) this.cpuBigHitCd -= dt;
    const carrier = this.ball.carrier;
    if (!carrier || carrier.isDown || this.phase !== "live" || this.cpuBigHitCd > 0) return;
    // Only on a runner in space — not the QB sitting in the pocket.
    const running =
      this.offensePlay.isRun || carrier.role !== "QB" ||
      (this.dir > 0 ? carrier.pos.x > this.startLosX : carrier.pos.x < this.startLosX);
    if (!running) return;
    // The defender chosen to lay the hit must be on the carrier's side (defending, not blocking).
    for (const d of this.defense) {
      if (d === this.controlled || d.isDown || d.diveTimer > 0) continue;
      const dx = carrier.pos.x - d.pos.x;
      const dy = carrier.pos.y - d.pos.y;
      const dd = Math.hypot(dx, dy) || 1;
      if (dd < 40 || dd > 82) continue; // a launch window: closing in, not already on top
      if (d.vel.x * dx + d.vel.y * dy <= 0) continue; // must actually be closing on him
      if (!chance(0.55)) { this.cpuBigHitCd = 0.25; return; } // sometimes just wrap up normally
      const f = Math.atan2(dy, dx);
      d.facing = f;
      d.heading = f;
      d.diveTimer = 0.3;
      d.bigHitArmed = true;
      d.animEvent = "dive"; // CPU diving tackle lunge
      d.leanTarget = 0.7;
      d.vel.x += Math.cos(f) * 165;
      d.vel.y += Math.sin(f) * 165;
      this.app.particles.burst(d.pos.x, d.pos.y, "#dce6ff", 5, 70);
      const diff = this.app.match.difficulty;
      this.cpuBigHitCd = diff === "allpro" ? 1.4 : diff === "pro" ? 1.9 : 2.8;
      return;
    }
  }

  /**
   * Hand the ball to `newCarrier` on a turnover and keep the play LIVE as a return. The AI roles
   * flip in place — the team that took the ball now escorts/blocks, the other team pursues — by
   * swapping the offense/defense role arrays (but NOT `this.all`, so avatars keep their identity).
   */
  private startReturn(newCarrier: Player, kind: "interception" | "fumble"): void {
    const m = this.app.match;
    if (newCarrier.team !== this.offenseTeamId) {
      const tmp = this.offense;
      this.offense = this.defense;
      this.defense = tmp;
    }
    this.offenseTeamId = newCarrier.team;
    this.humanIsOffense = newCarrier.team === m.humanTeam;
    this.dir = m.attackDir(newCarrier.team);
    this.startLosX = newCarrier.pos.x;
    this.qb = null;
    this.passThrown = true;
    this.passTarget = null;
    this.sackPossible = false;
    this.isReturn = true;
    this.returnFor = newCarrier.team;
    this.returnKind = kind;
    this.looseBall = false;
    this.ball.attachTo(newCarrier);
    this.cpu.reset(); // the CPU now steers the returner (if it's the CPU's ball) as an open runner
    if (this.controlled) this.controlled.controlled = false;
    this.controlled = this.humanIsOffense ? newCarrier : this.nearestDefenderToBall();
    if (this.controlled) this.controlled.controlled = true;
  }

  /** A fumble is live on the ground: the first player to reach it recovers. The offense keeping
   *  it plays on; the defense recovering takes it back as a (returnable) turnover. */
  private checkLooseBall(): void {
    if (!this.looseBall || this.ball.state !== "loose" || this.phase !== "live") return;
    this.looseTimer += 1 / 60;
    // The nearest upright player; he recovers on touch, or falls on it once the scramble drags on.
    let rec: Player | null = null;
    let bestD = Infinity;
    for (const p of this.all) {
      if (p.isDown) continue;
      const d = dist(p.pos, this.ball.pos);
      if (d < bestD) { bestD = d; rec = p; }
    }
    if (!rec) return;
    const onTouch = bestD < rec.radius + 10;
    if (!onTouch && this.looseTimer < 2.6) return; // still scrambling for it
    this.looseBall = false;
    this.looseTimer = 0;
    rec.animEvent = "pickup"; // scoop the loose ball
    this.app.particles.burst(rec.pos.x, rec.pos.y, "#ffffff", 8, 90);
    if (rec.team === this.offenseTeamId) {
      // Offense fell on its own fumble — keep the ball, play on.
      this.ball.attachTo(rec);
      if (this.controlled) this.controlled.controlled = false;
      this.controlled = this.humanIsOffense ? rec : this.controlled;
      if (this.controlled) this.controlled.controlled = true;
      this.app.audio.whistle();
      this.app.floating.add("RECOVERED!", rec.pos.x, rec.pos.y - 18, { size: 18, color: "#bfffd0", life: 0.9 });
    } else {
      // Defense recovered — it's a live, returnable turnover.
      this.app.audio.turnover();
      this.app.floating.add("FUMBLE!", rec.pos.x, rec.pos.y - 18, { size: 20, color: "#ff8a8a", life: 0.9 });
      if (rec.team === this.app.match.humanTeam) this.app.audio.crowdCheer(); else this.app.audio.crowdGroan();
      this.startReturn(rec, "fumble");
    }
  }

  /** A committed big hit that didn't connect leaves the defender overcommitted: when the lunge
   *  window closes without a tackle, they stumble (and the carrier slips by). The risk side. */
  private checkBigHitWhiff(): void {
    for (const d of this.defense) {
      if (d.bigHitArmed && d.diveTimer <= 0) {
        d.bigHitArmed = false;
        d.enterStumble(0.5);
        this.app.particles.burst(d.pos.x, d.pos.y, "#9aa6b8", 5, 70);
        if (d === this.controlled) this.app.floating.add("WHIFF!", d.pos.x, d.pos.y - 18, { size: 18, color: "#cdd6e6", life: 0.8 });
      }
    }
  }

  /** Is this defender close enough to the carrier that ACTION should be a tackle? */
  private defenderInTackleRange(c: Player): boolean {
    const carrier = this.ball.carrier;
    return !!carrier && !carrier.isDown && dist(c.pos, carrier.pos) < DEF_TACKLE_RANGE;
  }

  private startDive(c: Player): void {
    c.diveTimer = 0.34;
    c.animEvent = "dive"; // runner dive for the spot
    c.vel.x += Math.cos(c.facing) * 85;
    c.vel.y += Math.sin(c.facing) * 85;
    this.app.particles.burst(c.pos.x, c.pos.y, "#cfe8d4", 6, 70);
    // The dive ends the play shortly after, securing the spot.
  }

  /** Switch to the defender best placed to make a play: nearest to the carrier, or to
   * the pass's landing spot while the ball is in the air, or to the loose ball. */
  private switchDefender(): void {
    const point = this.ball.carrier
      ? this.ball.carrier.pos
      : this.ball.state === "inAir"
        ? this.ball.target
        : this.ball.pos;
    let best: Player | null = null;
    let bestD = Infinity;
    for (const d of this.defense) {
      if (d.isDown || d === this.controlled) continue;
      const dd = dist(d.pos, point);
      if (dd < bestD) {
        bestD = dd;
        best = d;
      }
    }
    if (best) this.setControlled(best);
  }

  /** Cycle control through the defenders (used pre-snap to pick your matchup). */
  private cycleDefender(): void {
    const list = this.defense.filter((d) => !d.isDown);
    if (list.length === 0) return;
    const idx = this.controlled ? list.indexOf(this.controlled) : -1;
    this.setControlled(list[(idx + 1) % list.length]);
  }

  private setControlled(p: Player | null): void {
    if (this.controlled) this.controlled.controlled = false;
    this.controlled = p;
    if (p) p.controlled = true;
  }

  /**
   * Throw the ball. `power` (0..1) blends a touch lob (0: high, floaty, slow) into a
   * bullet (1: flat, fast, tight spiral). A quick tap throws a lob; holding charges a
   * bullet. The receiver is led by the resulting flight time so fast WRs run onto it.
   */
  private throwPass(from: Player, target: Vec2, receiver: Player | null, power = 0.4): void {
    // A QB can only throw so far: clamp the aim to a realistic max range so a pass can't sail
    // 90 yards downfield. Beyond range the ball falls short (incomplete) rather than reaching.
    const dx = target.x - from.pos.x;
    const dy = target.y - from.pos.y;
    const d = Math.hypot(dx, dy);
    const maxPass = MAX_PASS_YARDS * PX_PER_YARD;
    const aim = d > maxPass ? { x: from.pos.x + (dx / d) * maxPass, y: from.pos.y + (dy / d) * maxPass } : target;
    // Lob -> bullet: faster + flatter + a tighter, quicker spiral as power climbs.
    const { speed, loft, spin } = throwParams(power);
    this.ball.throwTo(from, aim, speed, loft, spin);
    this.passThrown = true;
    this.passTarget = receiver;
    // Deep balls get the over-the-top heave (pitcher motion); normal throws the QB clip.
    from.animEvent = Math.min(d, maxPass) > maxPass * 0.62 ? "hailMary" : "pass";
    this.app.audio.throwBall();
    // The thrower's side has no carrier until the catch, so the offense human drops to
    // no-control (and can grab a receiver in the air). A defending human KEEPS their
    // defender so they can break on the ball.
    if (this.humanIsOffense) this.setControlled(null);
  }

  private resolvePassResult(res: { caught?: Player; intercepted?: Player; incomplete?: boolean; swatBy?: Player }): void {
    if (res.caught) {
      this.ball.attachTo(res.caught);
      this.passTarget = null;
      res.caught.animEvent = "catch";
      this.app.audio.catchBall();
      this.app.floating.add("CAUGHT!", res.caught.pos.x, res.caught.pos.y - 20, { size: 18, color: "#bfffd0" });
      if (res.caught.team === this.app.match.humanTeam) this.app.audio.crowdCheer();
      // Take control of the receiver on a catch — UNLESS in superstar mode, where you're locked to
      // your player (the QB) and just watch the catch + run.
      if (res.caught.team === this.app.match.humanTeam && this.humanIsOffense && !this.app.scene3d.superstarCam) {
        this.setControlled(res.caught);
      }
    } else if (res.intercepted) {
      res.intercepted.animEvent = "catch";
      this.app.audio.turnover();
      if (res.intercepted.team === this.app.match.humanTeam) this.app.audio.crowdCheer();
      else this.app.audio.crowdGroan();
      this.app.floating.add("INTERCEPTED!", res.intercepted.pos.x, res.intercepted.pos.y - 20, {
        size: 22,
        color: "#ff8a8a",
      });
      this.app.shake.add(0.4);
      // Live return: the pick is run back until the returner is tackled / scores / steps out.
      this.startReturn(res.intercepted, "interception");
    } else if (res.incomplete) {
      this.app.audio.whistle();
      if (this.humanIsOffense) this.app.audio.crowdGroan();
      if (res.swatBy) res.swatBy.animEvent = "swat"; // defender bats the pass down
      this.app.floating.add("INCOMPLETE", this.ball.pos.x, this.ball.pos.y - 10, { size: 18, color: "#ddd" });
      // Let the ball skip/bounce at the spot during the dead beat.
      this.ball.becomeLoose(this.ball.vel.x * 0.3, this.ball.vel.y * 0.3, 120);
      this.endPlay("incomplete", { x: this.startLosX, y: this.ball.pos.y });
    }
  }

  // --- physics --------------------------------------------------------------

  private moveAll(dt: number): void {
    const m = this.app.match;
    // Defense ramps up after the snap so plays can develop; the rate scales with
    // difficulty (Rookie gives more pocket time and bigger lanes).
    const diff = DIFFICULTY[m.difficulty];
    const react = Math.min(1, diff.reactBase + this.playTime * diff.reactRate);
    for (const p of this.all) {
      if (p.isDown) {
        p.step(dt, 0);
        continue;
      }
      const onFire = m.team(p.team).onFire;
      const diving = p.diveTimer > 0;
      const isDefense = p.team !== this.offenseTeamId;
      let mult = isDefense ? DIFFICULTY[m.difficulty].cpuSpeed * react : 1;
      // A blocker latched onto a defender drags them to a crawl (opens lanes).
      if (isDefense && this.isEngagedByBlocker(p)) mult *= 0.32;
      // A covering DB is flat-footed for a beat when his receiver breaks, so the
      // receiver gains real separation out of the cut.
      if (isDefense && p.job === "cover" && p.assignment && p.assignment.cutTimer > 0) mult *= 0.55;
      // Glancing-hit stumble drains a beat of speed.
      if (p.isStumbling) mult *= 0.5;
      const target = p.speedFor(p.turbo || diving, onFire) * mult;
      // The human-controlled player gets much snappier acceleration + sharper turning, so the
      // stick feels responsive — easy to cut, reverse, and weave — while the AI stays grounded.
      const human = p === this.controlled;
      const accelMul = human ? 3.2 : 1;
      p.agility = human ? 1.8 : 1;
      if (diving) {
        // Keep momentum during a dive (don't steer).
        p.step(dt, Math.hypot(p.vel.x, p.vel.y));
      } else {
        p.step(dt, target, accelMul);
      }
      // Keep everyone on the field: clamp to the sidelines and the back of the end zones (a TD
      // is detected at the goal line, well before the back, so this never blocks a score).
      p.pos.y = this.app.field.clampY(p.pos.y);
      p.pos.x = Math.max(this.app.field.minX, Math.min(this.app.field.maxX, p.pos.x));
    }
  }

  /** True if an offensive blocker is currently latched onto this defender. */
  private isEngagedByBlocker(d: Player): boolean {
    for (const o of this.offense) {
      if (o.job !== "block" || o.isDown) continue;
      const rr = o.radius + d.radius + 12;
      const dx = o.pos.x - d.pos.x;
      const dy = o.pos.y - d.pos.y;
      if (dx * dx + dy * dy < rr * rr) return true;
    }
    return false;
  }

  /** Push overlapping bodies apart so blockers wall defenders (blocking emerges). */
  private resolveBodies(): void {
    const carrier = this.ball.carrier;
    for (let i = 0; i < this.all.length; i++) {
      const a = this.all[i];
      if (a.isDown) continue;
      for (let j = i + 1; j < this.all.length; j++) {
        const b = this.all[j];
        if (b.isDown) continue;
        // The carrier's collisions are resolved by tackle logic, not separation.
        if (a === carrier || b === carrier) continue;
        const dx = b.pos.x - a.pos.x;
        const dy = b.pos.y - a.pos.y;
        // Pack a touch tighter than the full radii so bodies actually make contact (the collision
        // radius is larger than the visible model), instead of hovering with a gap.
        const min = (a.radius + b.radius) * 0.84;
        const d2 = dx * dx + dy * dy;
        // Reject the ~95% of non-overlapping pairs with a squared compare — only sqrt when they touch.
        if (d2 > 0 && d2 < min * min) {
          const d = Math.sqrt(d2);
          const overlap = min - d;
          if (overlap < 0.4) continue; // slop: ignore micro-overlaps to avoid buzzing
          const nx = dx / d;
          const ny = dy / d;
          // Blockers are "heavier", and stronger players (linemen) shove lighter ones around.
          const aMass = (a.job === "block" ? 3 : 1) * a.strength;
          const bMass = (b.job === "block" ? 3 : 1) * b.strength;
          const total = aMass + bMass;
          // Partial (spring-like) correction each frame instead of a hard teleport;
          // the geometric series still fully separates over a few frames.
          const c = 0.5;
          a.pos.x -= nx * overlap * (bMass / total) * c;
          a.pos.y -= ny * overlap * (bMass / total) * c;
          b.pos.x += nx * overlap * (aMass / total) * c;
          b.pos.y += ny * overlap * (aMass / total) * c;

          // Collision impulse: only when the two are actually closing, so contact
          // has weight (a bump) without jitter on resting/leaning bodies.
          const relN = (b.vel.x - a.vel.x) * nx + (b.vel.y - a.vel.y) * ny;
          if (relN < 0) {
            const j = -relN * 0.45;
            a.vel.x -= nx * j * (bMass / total);
            a.vel.y -= ny * j * (bMass / total);
            b.vel.x += nx * j * (aMass / total);
            b.vel.y += ny * j * (aMass / total);
          }
        }
      }
    }
  }

  /** Per-frame contact, delegated to the tackling engine (dynamic + gang tackles). */
  private checkTackles(): void {
    const carrier = this.ball.carrier;
    if (!carrier || carrier.isDown || this.phase !== "live") return;
    const outcome = this.tackle.resolve(this.tackleQuery(carrier));
    if (outcome.kind === "struggle") this.startStruggle(outcome.tackler, carrier);
    else if (outcome.kind === "gang") this.applyGangTackle(outcome.data);
    // none / whiff / stumble / broken: the engine already applied any effects; play continues.
  }

  /** Bundle the live-play context the tackling engine needs. Mutates one reused object (the engine
   *  consumes it synchronously and doesn't retain it) so the per-frame contact check allocates
   *  nothing, and resolves player→sim-index in O(1) via the cached simIndex. */
  private tackleQuery(carrier: Player): TackleQuery {
    const q = this._tackleQuery;
    q.carrier = carrier;
    q.defense = this.defense;
    q.dir = this.dir;
    q.isReturn = this.isReturn;
    q.controlled = this.controlled;
    q.struggleReady = this.struggleCd <= 0;
    q.playTime = this.playTime;
    return q;
  }
  private readonly _tackleQuery: TackleQuery = {
    carrier: null as unknown as Player, defense: [], dir: 1, isReturn: false, controlled: null,
    struggleReady: false, playTime: 0, indexOf: (p: Player) => p.simIndex,
  };

  /** Finish a committed (gang) tackle: pop a fumble loose, or schedule the whistle, and hold the
   *  camera for the ragdoll pile. */
  private applyGangTackle(data: GangTackle): void {
    if (data.fumble) {
      this.ball.becomeLoose(data.fumbleVel.x, data.fumbleVel.y, data.fumbleVel.up);
      this.looseBall = true;
      this.looseTimer = 0;
    } else {
      this.pendingTackle = { type: this.sackIfBehindLine(data.spot), spot: data.spot };
      this.pendingTackleTimer = data.beat;
      if (data.big && data.lead.team !== this.offenseTeamId) this.bumpFireStreakOnDefense();
    }
    this.ragdollIdx = data.ragdollIdx;
    this.holdForRagdoll = data.ragdollIdx.length > 0;
    this.ragdollFocus = data.focus;
    if (data.big) this.lastBigHit = true;
  }

  /** Lock the carrier + tackler into a mash battle. */
  private startStruggle(tackler: Player, carrier: Player): void {
    this.phase = "struggle";
    this.struggleCarrier = carrier;
    this.struggleTackler = tackler;
    this.struggleVal = 0.5;
    this.struggleTimer = STRUGGLE_TIME;
    this.struggleHumanCarrier = this.controlled === carrier;
    this.struggleFlash = 0;
    carrier.vel = { x: 0, y: 0 };
    tackler.vel = { x: 0, y: 0 };
    tackler.bigHitArmed = false; // it's a battle now, not a committed hit (no later whiff)
    tackler.diveTimer = 0;
    const ang = Math.atan2(carrier.pos.y - tackler.pos.y, carrier.pos.x - tackler.pos.x) || 0;
    // Lock them chest-to-chest so they're actually IN CONTACT (the old gap was the collision
    // radius being far larger than the visible body).
    this.struggleMid = { x: (carrier.pos.x + tackler.pos.x) / 2, y: (carrier.pos.y + tackler.pos.y) / 2 };
    this.struggleAng = ang;
    this.struggleHalf = (carrier.radius + tackler.radius) * 0.3;
    this.placeStrugglers(0);
    this.faceStruggler(tackler, ang);
    this.faceStruggler(carrier, ang + Math.PI);
    this.app.scene3d.hitZoom(STRUGGLE_TIME + 0.4); // punch the camera in on the battle
    this.app.audio.hit(0.4);
    this.app.shake.add(0.2);
    this.app.input.consumeTaps();
  }

  /** Place the two combatants chest-to-chest at the locked spot; `push` (-1..1) shoves them. */
  private placeStrugglers(push: number): void {
    const c = this.struggleCarrier;
    const t = this.struggleTackler;
    if (!c || !t) return;
    const off = this.struggleHalf * (1 + push);
    const cx = Math.cos(this.struggleAng) * off;
    const cy = Math.sin(this.struggleAng) * off;
    c.pos = { x: this.struggleMid.x + cx, y: this.struggleMid.y + cy };
    t.pos = { x: this.struggleMid.x - cx, y: this.struggleMid.y - cy };
  }

  private faceStruggler(p: Player, ang: number): void {
    p.heading = ang;
    p.facing = ang;
    p.loco.heading = ang;
    p.loco.speed = 0;
    p.loco.speed01 = 0;
    p.loco.moveRel = 0;
    p.loco.gait = "idle";
    p.loco.down = false;
    p.loco.contact = false;
  }

  private updateStruggle(dt: number): void {
    const c = this.struggleCarrier;
    const t = this.struggleTackler;
    if (!c || !t) { this.phase = "live"; return; }
    this.struggleTimer -= dt;
    this.struggleFlash = Math.max(0, this.struggleFlash - dt * 4);

    // Any tap (or the action button) is a mash.
    const mashes = this.app.input.consumeTaps().length + (this.app.input.actionPressed ? 1 : 0);
    if (mashes > 0) this.struggleFlash = 1;
    const humanPush = mashes * STRUGGLE_TAP;
    // The CPU pushes harder when its man is the stronger of the two (a bruising LB on a WR).
    const cpuStr = this.struggleHumanCarrier ? t.strength : c.strength;
    const humanStr = this.struggleHumanCarrier ? c.strength : t.strength;
    const cpuPush = STRUGGLE_CPU * dt * clamp(cpuStr / humanStr, 0.6, 1.7);
    // The carrier drives the meter toward 1 (break free); the tackler toward 0 (tackle).
    this.struggleVal += this.struggleHumanCarrier ? humanPush - cpuPush : cpuPush - humanPush;
    this.struggleVal = Math.max(0, Math.min(1, this.struggleVal));

    // Wrestle: a bounded shove (oscillates around the locked spot — never drifts apart) + lean.
    this.placeStrugglers(Math.sin(this.playTime * 26) * 0.18);
    c.leanTarget = -0.5; t.leanTarget = 0.5;
    if (Math.random() < 0.25) this.app.particles.burst((c.pos.x + t.pos.x) / 2, (c.pos.y + t.pos.y) / 2, "#d9c7a0", 2, 50);

    if (this.struggleVal >= 1 || (this.struggleTimer <= 0 && this.struggleVal >= 0.5)) { this.resolveStruggle(true); return; }
    if (this.struggleVal <= 0 || this.struggleTimer <= 0) { this.resolveStruggle(false); return; }
    this.syncScene(dt);
  }

  private resolveStruggle(carrierWon: boolean): void {
    const c = this.struggleCarrier!;
    const t = this.struggleTackler!;
    this.struggleCarrier = null;
    this.struggleTackler = null;
    this.struggleCd = 3.0; // long cooldown so battles don't chain across a single play
    c.leanTarget = 0;
    t.leanTarget = 0;
    this.phase = "live";
    if (carrierWon) {
      c.jukeTimer = 0.5; // brief immunity so he actually escapes
      const burst = c.baseSpeed * 0.95;
      c.vel.x = this.dir * burst;
      c.vel.y *= 0.4;
      t.knockDown(0.95);
      this.app.particles.burst(c.pos.x, c.pos.y, "#bfffd0", 10, 120);
      this.app.audio.juke();
      this.app.shake.add(0.3);
      this.app.floating.add("BROKE FREE!", c.pos.x, c.pos.y - 22, { size: 26, color: "#bfffd0" });
    } else {
      this.app.floating.add(this.struggleHumanCarrier ? "STUFFED!" : "TACKLE!", (c.pos.x + t.pos.x) / 2, c.pos.y - 22, { size: 24, color: "#ffd23a" });
      this.applyGangTackle(this.tackle.commitTackle(this.tackleQuery(c), t));
    }
  }

  /** Keep each ragdolling player's sim position glued to its physics hips, so the camera, the
   *  ball spot and the selection follow the tumbling body. */
  private trackRagdolls(): void {
    if (!this.holdForRagdoll) return;
    for (const idx of this.ragdollIdx) {
      const hips = this.app.scene3d.ragdollHipsPx(idx);
      const p = this.all[idx];
      if (hips && p) { p.pos.x = hips.x; p.pos.y = this.app.field.clampY(hips.y); }
    }
  }

  /** Classify a tackle at `spot`: a safety if downed in the offense's own end zone, a
   * sack if the QB is dropped behind the line, otherwise a normal tackle. */
  private sackIfBehindLine(spot: Vec2): OutcomeType {
    const inOwnEndzone = this.offenseTeamId === "HOME" ? spot.x <= LEFT_GOAL_X : spot.x >= RIGHT_GOAL_X;
    if (inOwnEndzone) {
      this.app.floating.add("SAFETY!", spot.x, spot.y - 20, { size: 24, color: "#ff9a9a" });
      return "safety";
    }
    const carrierWasQB = this.ball.carrier?.role === "QB";
    const behind = this.dir > 0 ? spot.x < this.startLosX : spot.x > this.startLosX;
    if (carrierWasQB && behind && this.sackPossible) return "sack";
    return "tackle";
  }

  /** A big defensive hit stokes the defense's fire a little (on top of the play-outcome grade). */
  private bumpFireStreakOnDefense(): void {
    this.igniteCheck(this.app.match.opponent(this.offenseTeamId), 0.12);
  }

  /**
   * Grade the finished play and feed the ON FIRE meters: good plays build the responsible team's
   * fire, bad plays break the streak. Strung together, good plays light the whole team up.
   */
  private gradePlay(o: PlayOutcome): void {
    const m = this.app.match;
    const offense = this.offenseTeamId;
    const defense = m.opponent(offense);
    const offT = m.team(offense);
    const yards = o.yards;
    switch (o.type) {
      case "touchdown":
        this.igniteCheck(offense, 0.6); m.recordGain(offense, yards, true); m.recordTouchdown(offense);
        break;
      case "sack":
        this.igniteCheck(defense, 0.45); offT.breakStreak(); m.recordSack(defense); m.recordGain(offense, yards, false);
        break;
      case "interception":
      case "fumbleLost":
        this.igniteCheck(defense, 0.7); offT.breakStreak(); m.recordTakeaway(defense);
        break;
      case "safety":
        this.igniteCheck(defense, 0.7); offT.breakStreak();
        break;
      case "turnoverOnDowns":
        this.igniteCheck(defense, 0.4); offT.breakStreak();
        break;
      case "tackle":
      case "outOfBounds":
        m.recordGain(offense, yards, o.firstDown);
        if (o.firstDown) this.igniteCheck(offense, yards >= 18 ? 0.5 : 0.34);
        else if (yards <= 1) this.igniteCheck(defense, 0.25); // a stuff
        break;
      case "incomplete":
        if (m.down === 1 && !o.firstDown) this.igniteCheck(defense, 0.2); // forced a stop / punt situation
        break;
    }
    this.commentate(o);
  }

  /**
   * One punchy, street-flavored call-out on a notable play. Kept to a SINGLE local floating line:
   * the formal result (e.g. "INTERCEPTED!", "SACKED!") is already shown by the dead-ball result
   * panel, so we don't also slam a redundant full-screen banner here — that screen banner is now
   * reserved for ON FIRE. A stinger still rings on the marquee takeaways for audio punch.
   */
  private commentate(o: PlayOutcome): void {
    const pick = (arr: string[]) => arr[(Math.random() * arr.length) | 0];
    let line: string | null = null;
    let color = "#ffd23a";
    let big = false; // a marquee turnover/sack — earns an audio stinger
    switch (o.type) {
      case "sack": line = pick(["SACKED!", "BROUGHT HIM DOWN!", "GET OUTTA HERE!"]); color = "#ff6a3a"; big = true; break;
      case "interception": line = pick(["PICKED OFF!", "BALL'S OURS!", "READ IT EASY!"]); color = "#ff5a3a"; big = true; break;
      case "fumbleLost": line = pick(["COUGHED IT UP!", "STRIPPED!", "TAKEAWAY!"]); color = "#ff5a3a"; big = true; break;
      case "turnoverOnDowns": line = pick(["STONEWALLED!", "STUFFED ON DOWNS!", "DENIED!"]); color = "#ff6a3a"; big = true; break;
      case "tackle":
      case "outOfBounds":
        if (o.yards >= 22) line = pick(["TAKIN' OFF!", "BIG GAINER!", "TO THE RACES!"]);
        else if (o.firstDown) { line = pick(["MOVIN' THE CHAINS!", "FIRST DOWN!", "KEEP IT ROLLIN'!"]); color = "#3ad17a"; }
        break;
    }
    if (line) {
      const s = this.ballSpot();
      // Float the street call-out well above the pile (h) so it never sits on the ball/runner. The
      // formal result still reads in the dead-ball panel — this in-world line is a deliberate extra.
      this.app.floating.add(line, s.x, s.y, { size: 22, color, life: 1.2, h: 58 });
    }
    if (big) this.app.audio.stinger();
  }

  /** Add fire to a team; announce + celebrate the moment it ignites. */
  private igniteCheck(teamId: "HOME" | "AWAY", amount: number): void {
    const team = this.app.match.team(teamId);
    if (team.addFire(amount)) {
      this.app.audio.fire();
      this.app.shake.add(0.3);
      // The screen banner is the headline for ignition (no floating tag — keeps it uncluttered).
      this.app.banner.show("ON FIRE!", { color: "#ff8a1e", accent: "#ffd23a", sub: team.config.name.toUpperCase(), life: 2.2 });
      this.celebrateTeam(teamId);
    }
  }

  private checkBoundaries(): void {
    const carrier = this.ball.carrier;
    if (!carrier || this.phase !== "live") return;

    // Touchdown: carrier reaches the attacking end zone.
    const inAttackEndzone =
      this.offenseTeamId === "HOME" ? carrier.pos.x >= RIGHT_GOAL_X : carrier.pos.x <= LEFT_GOAL_X;
    if (inAttackEndzone) {
      this.scoreTouchdown(carrier);
      return;
    }

    // A safety is NOT called just for being in your own end zone (the QB can snap or
    // drop back there) — only when the carrier is tackled/downed there. That's handled
    // at the tackle spot in classifyTackle().

    // Out of bounds (sidelines).
    if (carrier.pos.y <= this.app.field.minY + 3 || carrier.pos.y >= this.app.field.maxY - 3) {
      this.app.audio.whistle();
      this.endPlay("outOfBounds", { x: carrier.pos.x, y: carrier.pos.y });
    }
  }

  private scoreTouchdown(carrier: Player): void {
    this.app.audio.airHorn();
    if (carrier.team === this.app.match.humanTeam) {
      this.app.audio.crowdCheer(2); // full TD roar
      this.app.audio.organCharge();
    } else {
      this.app.audio.crowdGroan();
    }
    this.app.shake.add(0.6);
    this.app.particles.confetti(carrier.pos.x, carrier.pos.y, 50);
    // No floating tag or screen banner here — the dead-ball score celebration panel is the headline.
    this.app.time.slow(0.4, 0.5);
    // The whole scoring unit breaks into a celebration during the post-play beat.
    this.celebrate(this.scoringTeamPlayers(carrier));
    this.endPlay("touchdown", { x: carrier.pos.x, y: carrier.pos.y });
  }

  /** Players on the same team as `p` who are upright (eligible to celebrate). */
  private scoringTeamPlayers(p: Player): Player[] {
    return this.all.filter((q) => q.team === p.team && !q.isDown);
  }

  /** Trigger the celebration animation on a group of players (staggered a touch). */
  private celebrate(players: Player[]): void {
    for (const p of players) {
      p.vel.x = 0;
      p.vel.y = 0;
      p.animEvent = "celebrate";
    }
  }

  /** Celebrate every upright player on a team — used for big plays during the post-play beat. */
  private celebrateTeam(team: "HOME" | "AWAY"): void {
    this.celebrate(this.all.filter((q) => q.team === team && !q.isDown));
  }

  /** Two-minute warning: stop the clock (it restarts on the next snap) and flash the notice, once
   *  per half. No-op for short arcade quarters that never reach 2:00. */
  private applyTwoMinuteWarning(): void {
    if (this.app.match.checkTwoMinuteWarning()) {
      this.clockRunning = false;
      this.app.audio.whistle();
      this.app.floating.add("TWO-MINUTE WARNING", this.app.field.maxX / 2, this.app.field.maxY / 2, { size: 26, color: COLORS.hazard, life: 2.4 });
    }
  }

  /** The quarter only advances between plays (not mid-down); show a beat when the clock expires. */
  private quarterBeat(): void {
    const m = this.app.match;
    if (m.clockExpired && !m.isOver) {
      const ev = m.advanceQuarter();
      this.quarterBannerText = ev === "half" ? "HALFTIME" : ev === "game" ? "FINAL" : `END OF Q${m.quarter - 1}`;
      this.quarterBannerT = 2.8;
      this.app.audio.whistle();
      if (ev === "half") this.app.audio.organCharge();
    }
  }

  /** Draw the quarter / halftime break card (crests + running score) when one is active. The
   *  big breaks (HALFTIME / FINAL) get a full-screen scrim so they read as a broadcast bumper. */
  private renderQuarterBanner(r: Renderer): void {
    if (this.quarterBannerT <= 0) return;
    const m = this.app.match;
    const a = Math.max(0, Math.min(1, Math.min(1, this.quarterBannerT) * Math.min(1, (2.8 - this.quarterBannerT) * 4 + 0.001)));
    const big = this.quarterBannerText === "HALFTIME" || this.quarterBannerText === "FINAL";
    const ctx = r.ctx;
    ctx.save();
    // Dim the field behind the marquee breaks.
    if (big) { ctx.globalAlpha = a * 0.6; ctx.fillStyle = "#06080c"; ctx.fillRect(0, 0, r.width, r.height); }
    ctx.globalAlpha = a;
    const w = Math.min(440, r.width - 48), h = 132, x = (r.width - w) / 2, y = r.height * 0.28;
    drawPanel(r, { x, y, w, h });
    r.text(this.quarterBannerText, r.width / 2, y + 32, { size: 30, align: "center", color: COLORS.hazard, font: FONT.display });
    // Crests flank the score line.
    const cy = y + 84;
    const crestR = Math.min(30, w * 0.1);
    drawCrest(ctx, x + w * 0.2, cy, crestR, m.home.config);
    drawCrest(ctx, x + w * 0.8, cy, crestR, m.away.config);
    r.text(`${m.home.score}  —  ${m.away.score}`, r.width / 2, cy, { size: 32, align: "center", color: COLORS.bone, baseline: "middle", font: FONT.display });
    r.text(m.home.config.abbr, x + w * 0.2, cy + crestR + 12, { size: 12, align: "center", color: COLORS.ash, baseline: "middle", font: FONT.ui });
    r.text(m.away.config.abbr, x + w * 0.8, cy + crestR + 12, { size: 12, align: "center", color: COLORS.ash, baseline: "middle", font: FONT.ui });
    ctx.restore();
  }

  private ballSpot(): Vec2 {
    const c = this.ball.carrier;
    return c ? { x: c.pos.x, y: c.pos.y } : { x: this.ball.pos.x, y: this.ball.pos.y };
  }

  private endPlay(type: OutcomeType, spot: Vec2): void {
    if (this.phase === "dead") return;
    this.phase = "dead";
    // Ref's whistle blows the play dead on a down-by-contact (TDs get the air horn instead).
    if (type === "tackle" || type === "sack") this.app.audio.whistleDead();
    if (this.controlled) this.controlled.controlled = false;
    this.passTarget = null;
    this.looseBall = false;
    const m = this.app.match;

    // A two-point conversion try: reaching the end zone is worth 2; anything else fails. Either
    // way the scoring team then kicks off (no normal down logic).
    if (this.twoPoint) {
      const team = this.twoPointTeam;
      const good = type === "touchdown" && this.offenseTeamId === team; // a turnover-return TD doesn't count
      if (good) m.addPoints(team, TWO_POINT_POINTS);
      m.twoPointActive = false;
      m.team(m.opponent(team)).extinguish();
      this.playResult = { scored: good, changedPossession: true, kickoff: true, kickReceiver: m.opponent(team), scoringTeam: good ? team : undefined };
      this.pendingOutcome = { type: good ? "touchdown" : "tackle", ballX: spot.x, ballY: spot.y, possessionAfter: m.opponent(team), yards: 0, firstDown: false, headline: good ? "TWO-POINT — GOOD!" : "NO GOOD" };
      this.resultDetail = good ? `${m.team(team).config.name.toUpperCase()} +2` : "CONVERSION FAILED";
      this.quarterBeat();
      if (good) this.celebrateTeam(team);
      this.clockRunning = false;
      this.deadTimer = 2.2; this.deadElapsed = 0;
      this.endSpot = { x: spot.x, y: spot.y }; this.regroupTargets = null; this.deadFocus = { x: spot.x, y: spot.y };
      this.app.input.consumeTaps();
      return;
    }

    // A kickoff / punt return ending: a return TD scores; otherwise the receiving team simply
    // begins its drive at the spot (NOT a turnover — they always had the ball coming).
    if (this.returnKind === "kick" && this.isReturn && this.returnFor) {
      const scored = type === "touchdown";
      if (scored) {
        this.playResult = m.returnResult(this.returnFor, spot.x, true);
      } else {
        const spotX = Math.max(LEFT_GOAL_X, Math.min(RIGHT_GOAL_X, spot.x));
        m.startSeries(this.returnFor, spotX);
        this.playResult = { scored: false, changedPossession: false, kickoff: false };
      }
      this.pendingOutcome = {
        type: scored ? "touchdown" : "tackle",
        ballX: spot.x, ballY: spot.y, possessionAfter: this.returnFor,
        yards: 0, firstDown: false,
        headline: scored ? "RETURN TD!" : "RETURN",
      };
      this.resultDetail = this.buildResultDetail();
      this.quarterBeat();
      if (scored) this.celebrateTeam(this.returnFor);
      // A return tackled inbounds keeps the clock running; a return TD stops it (kickoff follows).
      this.clockRunning = !scored && spot.y > this.app.field.minY + 4 && spot.y < this.app.field.maxY - 4;
      this.applyTwoMinuteWarning();
      this.deadTimer = scored ? 2.6 : 1.4;
      this.deadElapsed = 0;
      this.endSpot = { x: spot.x, y: spot.y };
      this.regroupTargets = null;
      this.deadFocus = { x: spot.x, y: spot.y };
      this.app.input.consumeTaps();
      return;
    }

    // A turnover RETURN ending: the returning team scores or takes over at the spot. (Handled
    // separately because the play's offense/defense were flipped while the return was live.)
    if (this.isReturn && this.returnFor) {
      const scored = type === "touchdown";
      this.playResult = m.returnResult(this.returnFor, spot.x, scored);
      this.pendingOutcome = {
        type: scored ? "touchdown" : "interception",
        ballX: spot.x, ballY: spot.y, possessionAfter: this.returnFor,
        yards: 0, firstDown: false,
        headline: scored ? "RETURN TD!" : this.returnKind === "interception" ? "INTERCEPTION" : "FUMBLE!",
      };
      this.resultDetail = this.buildResultDetail();
      this.quarterBeat();
      this.celebrateTeam(this.returnFor); // the takeaway unit celebrates
      this.clockRunning = false; // a turnover stops the clock
      this.deadTimer = scored ? 2.6 : 1.8;
      this.deadElapsed = 0;
      this.endSpot = { x: spot.x, y: spot.y };
      this.regroupTargets = null;
      this.deadFocus = { x: spot.x, y: spot.y };
      this.app.input.consumeTaps();
      return;
    }

    const gained = (spot.x - this.startLosX) * this.dir / PX_PER_YARD;
    const possessionAfter =
      type === "interception" || type === "fumbleLost" || type === "safety"
        ? m.opponent(this.offenseTeamId)
        : this.offenseTeamId;

    const outcome: PlayOutcome = {
      type,
      ballX: spot.x,
      ballY: spot.y,
      possessionAfter,
      yards: Math.round(gained),
      firstDown: false,
      headline: headlineFor(type, Math.round(gained)),
    };
    this.pendingOutcome = outcome;

    // Apply the result to the rules NOW (so the HUD reflects it during the on-field
    // beat) and build the result lines shown on the field — there's no separate banner
    // screen anymore; a single tap goes straight to the next play.
    this.playResult = m.applyOutcome(outcome);
    this.resultDetail = this.buildResultDetail();
    this.gradePlay(outcome);

    this.quarterBeat();

    // Celebrate the big plays during the post-play beat: the defense after a sack / takeaway, or
    // the offense after a touchdown (handled in scoreTouchdown) or an explosive gain.
    const defense = m.opponent(this.offenseTeamId);
    if (type === "sack" || type === "safety" || type === "interception" || type === "fumbleLost") {
      this.celebrateTeam(defense);
    } else if (type === "touchdown") {
      // already kicked off in scoreTouchdown
    } else if (gained >= 18) {
      this.celebrateTeam(this.offenseTeamId);
    }

    // Post-play: a short settle/celebration, then players regroup and amble toward the
    // huddle until the player taps to continue (or the hard cap elapses).
    this.deadTimer =
      type === "touchdown" ? 2.6
      : type === "interception" || type === "fumbleLost" ? 1.8
      : type === "incomplete" ? 1.8 // let the throwaway read + receivers pull up, not an instant cut
      : 1.4;
    // Clock management (real football): it keeps running between plays only when the ball was
    // downed inbounds (a run/tackle/sack); it stops on incompletions, out-of-bounds and scores.
    // (A first down does NOT stop the clock — that's a college rule, not the NFL.)
    this.clockRunning = (type === "tackle" || type === "sack") &&
      spot.y > this.app.field.minY + 4 && spot.y < this.app.field.maxY - 4;
    this.applyTwoMinuteWarning();
    this.deadElapsed = 0;
    this.endSpot = { x: spot.x, y: spot.y };
    this.regroupTargets = null;
    // Hold the post-play camera on where the play actually finished (the ball — i.e. an
    // incompletion at the catch point, or the spot of the down), not back on the QB.
    const bs = this.ballSpot();
    this.deadFocus = { x: bs.x, y: bs.y };
    // Drain any stale taps so input from the play itself (e.g. a quick tap-throw leaves a tap in
    // the buffer, since the live phase never consumes taps) can't instantly skip the post-play.
    this.app.input.consumeTaps();
  }

  /** The line under the result headline, read from the applied match state. */
  private buildResultDetail(): string {
    const m = this.app.match;
    const res = this.playResult;
    if (res?.scored && res.scoringTeam) return `${m.team(res.scoringTeam).config.name.toUpperCase()} SCORE!`;
    if (this.pendingOutcome?.firstDown) {
      this.app.audio.firstDownChime();
      return "FIRST DOWN!";
    }
    if (res?.changedPossession) return "TURNOVER!";
    return `${ordinal(m.down)} & ${m.distanceYards}`;
  }

  /**
   * Post-whistle beat: bodies settle / the score is celebrated, then players amble back
   * toward the huddle while the result lingers on the field. It waits for a tap to skip
   * to the result + play call, with a hard cap so it can never hang.
   */
  private updateDeadBeat(dt: number): void {
    this.deadTimer -= dt;
    this.deadElapsed += dt;
    // A brief on-field result beat: the whistle blows, the result reads, players settle / the
    // ball-carrier's ragdoll finishes falling and gets up. We DON'T cut away — the camera holds
    // on the play and then the broadcast play-call comes up as an overlay (commitOutcome), with
    // the field still living behind it. The hold respects an in-progress ragdoll tackle.
    const busy = this.holdForRagdoll && this.app.scene3d.ragdollsBusy();
    if (this.clockRunning) { this.app.match.tickClock(dt); this.applyTwoMinuteWarning(); } // clock runs on after an inbounds play
    for (const p of this.all) p.step(dt, 0); // coast to a stop / lie tackled / celebrate in place
    this.ball.update(dt);
    this.spawnFireFx();
    // The beat advances on its own once the result has shown and any tackle has resolved. A
    // deliberate tap can skip ahead, but only after a brief minimum linger — so input from the
    // play itself (a tap-throw, a held action button) can't instantly cut the post-play. We
    // drain taps every frame regardless, and the action button is NOT a skip (it's gameplay).
    const taps = this.app.input.consumeTaps();
    if (this.replay.available && taps.some((t) => tappedIn(this.replayBtn, [t]))) {
      this.enterReplay();
      return;
    }
    // Broadcast touch: the highlight plays (scores, takeaways, big hits) automatically roll an
    // instant replay once the on-field beat has had a moment to land — scores show the celebration
    // first, big hits let the live ragdoll register, then we cut to the slow-mo (entering the
    // replay re-spawns the tackle from the recording, so we don't wait for it to settle live).
    // Everything else keeps the manual REPLAY button.
    const o = this.pendingOutcome;
    const score = o?.type === "touchdown" || o?.type === "safety";
    const delay = score ? 1.6 : this.lastBigHit ? 1.4 : 1.1;
    if (this.autoReplayWorthy() && this.replay.available && !this.autoReplayDone
        && this.deadElapsed > delay) {
      this.autoReplayDone = true;
      this.enterReplay(true);
      return;
    }
    const tapped = taps.length > 0;
    const beatDone = this.deadTimer <= 0 && !busy;
    const skipped = tapped && this.deadElapsed >= MIN_DEAD_LINGER;
    if (beatDone || skipped || this.deadElapsed >= POSTPLAY_MAX) {
      this.commitOutcome();
      return;
    }
    this.syncScene(dt);
  }

  /** Which outcomes earn a hands-off broadcast replay: scores, takeaways, and big hits. */
  private autoReplayWorthy(): boolean {
    const o = this.pendingOutcome;
    if (!o) return false;
    switch (o.type) {
      case "touchdown":
      case "safety":
      case "interception":
      case "fumbleLost":
        return true; // real highlights — worth the hands-off replay
      // Big-hit tackles/sacks no longer force a replay (they happen most plays and killed the tempo);
      // they still get the live hit-cam. The replay button is always there to roll one on demand.
      default:
        return false;
    }
  }

  /** Open the instant replay (from the post-play beat or the play-call overlay). `auto` is the
   * hands-off broadcast replay (touchdowns): it rolls in slow-mo, tight, and closes itself. */
  private enterReplay(auto = false): void {
    if (!this.replay.available) return;
    this.replayAuto = auto;
    this.replaySpeed = auto ? 0.5 : 1; // slow-mo for the broadcast cut
    this.replayHold = 0;
    this.replayFrom = this.phase === "playcall" ? "playcall" : "dead";
    this.phase = "replay";
    this.replayT = 0;
    this.replayLastIdx = -1;
    this.replayPlaying = true;
    if (auto) this.replayZoom = 0.7; // tight, cinematic
    this.replay.rewind();
    this.app.scene3d.resetAvatars(); // clear any ragdoll so the ghosts animate cleanly
    this.app.input.consumeTaps();
    // Offer free-look orbit/pan/zoom on a user-opened replay (not the hands-off broadcast cut).
    if (!auto) {
      this.freeCam ??= new FreeCamController(this.app.scene3d.getCamera());
      this.freeCam.onChange = (active) => { this.app.scene3d.freeCam = active; };
      this.freeCam.reset(); // fresh framing for this play (don't reuse a prior play's locked pose)
      this.freeCam.show(true);
    }
  }

  private exitReplay(): void {
    // After the hands-off touchdown replay, move along promptly to the PAT instead of
    // re-running the full post-play timer.
    if (this.replayAuto && this.replayFrom === "dead") this.deadTimer = Math.min(this.deadTimer, 0.5);
    this.phase = this.replayFrom;
    this.replayAuto = false;
    this.replaySpeed = 1;
    this.freeCam?.show(false); // hides the toggle + deactivates free-look (restores follow cam)
    this.app.scene3d.freeCam = false;
    this.app.scene3d.resetAvatars();
    this.app.input.consumeTaps();
  }

  private scrubTime(x: number, dur: number): number {
    const f = (x - this.rcSlider.x) / Math.max(1, this.rcSlider.w);
    return Math.max(0, Math.min(1, f)) * dur;
  }

  /** Play back the recorded play: scrub with the slider, zoom in/out, camera tracks the ball. */
  private updateReplay(dt: number): void {
    const input = this.app.input;
    const dur = this.replay.duration;

    const taps = input.consumeTaps();
    if (this.replayAuto) {
      // A hands-off broadcast replay: a single tap skips it; no transport controls.
      if (taps.length) { this.exitReplay(); return; }
    } else {
      for (const t of taps) {
        if (tappedIn(this.rcClose, [t])) { this.exitReplay(); return; }
        if (tappedIn(this.rcPlay, [t])) {
          if (this.replayT >= dur - 0.02) { this.replayT = 0; this.replay.rewind(); this.app.scene3d.resetAvatars(); }
          this.replayPlaying = !this.replayPlaying;
        } else if (tappedIn(this.rcZoomIn, [t])) this.replayZoom = Math.min(1, this.replayZoom + 0.25);
        else if (tappedIn(this.rcZoomOut, [t])) this.replayZoom = Math.max(0, this.replayZoom - 0.25);
        else if (tappedIn(this.rcSlider, [t])) { this.replayT = this.scrubTime(t.x, dur); this.replayPlaying = false; }
      }
      // Drag anywhere along the slider band to scrub.
      const d = input.drag;
      if (d && this.rcSlider.w > 0 &&
          d.x > this.rcSlider.x - 24 && d.x < this.rcSlider.x + this.rcSlider.w + 24 &&
          d.y > this.rcSlider.y - 36 && d.y < this.rcSlider.y + this.rcSlider.h + 36) {
        this.replayT = this.scrubTime(d.x, dur);
        this.replayPlaying = false;
      }
    }

    if (this.replayPlaying) {
      this.replayT += dt * this.replaySpeed;
      if (this.replayT >= dur) { this.replayT = dur; this.replayPlaying = false; this.replayHold = 0; }
    }
    this.replayT = Math.max(0, Math.min(dur, this.replayT));
    // An auto replay closes itself after a short hold on the final frame.
    if (this.replayAuto && !this.replayPlaying) {
      this.replayHold += dt;
      if (this.replayHold > 0.7) { this.exitReplay(); return; }
    }

    // A scrub/rewind jump can't drive live ragdoll physics, which only moves forward. If the
    // timeline jumped backward (or skipped ahead), dispose any active ragdoll so the avatar
    // renders the RECORDED pose at the new time instead of staying flopped; it re-spawns when
    // forward playback reaches the tackle again.
    const idx = Math.round(this.replayT * 60);
    if ((idx < this.replayLastIdx || idx > this.replayLastIdx + 6) && this.app.scene3d.ragdollsBusy()) {
      this.app.scene3d.resetAvatars();
    }
    this.replayLastIdx = idx;

    const fr = this.replay.sample(this.replayT);
    // When the replay reaches a tackle, re-spawn the physics ragdoll (instead of the canned clip)
    // so the hit tumbles with real ragdoll physics, like it did live.
    this.spawnReplayRagdolls(fr.players);
    this.app.scene3d.sync({
      players: fr.players, ball: fr.ball, colorFor: fr.colorFor,
      focusX: fr.focusX, focusY: fr.focusY, dir: this.dir,
      losX: this.startLosX, firstDownX: this.app.match.firstDownX,
      shakeX: 0, shakeY: 0, dt,
    });
    // Free-look owns the camera while active; otherwise the auto ball-tracking replay cam runs.
    if (this.freeCam?.active) this.freeCam.update();
    else this.app.scene3d.replayCam(fr.focusX, fr.focusY, this.dir, this.replayZoom);
  }

  /** On a recorded tackle event during forward playback, fire the ragdoll on those avatars and
   *  clear the event so the canned tackle clip doesn't play instead. */
  private spawnReplayRagdolls(players: Player[]): void {
    const carrier = players.find((g) => g.animEvent === "tackle");
    const tackler = players.find((g) => g.animEvent === "tackleMade");
    const velOf = (g: Player) => ({ x: g.loco.speed * Math.cos(g.loco.heading), y: g.loco.speed * Math.sin(g.loco.heading) });
    if (carrier) {
      const v = velOf(carrier);
      const dx = tackler ? carrier.pos.x - tackler.pos.x : Math.cos(carrier.loco.heading);
      const dy = tackler ? carrier.pos.y - tackler.pos.y : Math.sin(carrier.loco.heading);
      this.app.scene3d.startRagdoll(players.indexOf(carrier), { hitDirX: dx, hitDirY: dy, closingPx: 170, carryVx: v.x, carryVy: v.y, big: true, bit: 0x0002 });
      carrier.animEvent = null;
    }
    if (tackler) {
      const v = velOf(tackler);
      const dx = carrier ? tackler.pos.x - carrier.pos.x : Math.cos(tackler.loco.heading);
      const dy = carrier ? tackler.pos.y - carrier.pos.y : Math.sin(tackler.loco.heading);
      this.app.scene3d.startRagdoll(players.indexOf(tackler), { hitDirX: dx, hitDirY: dy, closingPx: 110, carryVx: v.x, carryVy: v.y, big: true, bit: 0x0004 });
      tackler.animEvent = null;
    }
  }

  /** Open the between-downs play-call as a broadcast overlay over the still-live field. */
  private enterPlayCall(): void {
    const m = this.app.match;
    this.phase = "playcall";
    this.playCallT = 0;
    // Clear the previous-play result marquee so it doesn't stack on top of the "CALL IT" header.
    this.app.banner.clear();
    this.computeRegroupTargets();
    this.playCall.layout(this.app.r, m.possession === m.humanTeam);
    const top = 12 + this.app.r.safe.top;
    this.practiceExitRect = { x: 14 + this.app.r.safe.left, y: top, w: 84, h: 30 };
    this.app.input.consumeTaps(); // don't let the skip-tap also pick a card
  }

  /**
   * Between-downs broadcast view: the cards are overlaid while the field keeps living —
   * players amble back to the huddle and settle, the camera eases onto the huddle — until the
   * human picks a play, which arms the next down in place (no cut to a separate screen).
   */
  private updatePlayCall(dt: number): void {
    const m = this.app.match;
    if (this.clockRunning) { m.tickClock(dt); this.applyTwoMinuteWarning(); } // a running clock keeps ticking through the huddle
    this.playCallT = Math.min(1, this.playCallT + dt * 3);
    for (const p of this.all) {
      if (!p.isDown) this.walkToRegroup(p, dt); // jog back to the huddle, then idle there
      else p.step(dt, 0);
    }
    this.ball.update(dt);
    this.spawnFireFx();

    const taps = this.app.input.consumeTaps();
    if (m.practice && taps.some((t) => tappedIn(this.practiceExitRect, [t]))) {
      this.app.audio.stopCrowd();
      this.app.setState(new MenuState(this.app));
      return;
    }
    if (this.replay.available && taps.some((t) => tappedIn(this.replayBtn, [t]))) {
      this.enterReplay();
      return;
    }
    const pick = this.playCall.pick(taps);
    if (pick) {
      this.app.audio.uiConfirm();
      // The human picks their side; the CPU calls the opposing play situationally.
      const off = pick.off ?? cpuOffensePlay(m);
      const def = pick.def ?? cpuDefensePlay(m);
      this.armPlay(off, def);
      return;
    }
    this.syncScene(dt);
  }

  /** Amble a player back toward a loose post-play huddle (offense) / their side (defense). */
  private walkToRegroup(p: Player, dt: number): void {
    if (!this.regroupTargets) this.computeRegroupTargets();
    const t = this.regroupTargets!.get(p);
    if (!t) {
      p.step(dt, 0);
      return;
    }
    const dx = t.x - p.pos.x;
    const dy = t.y - p.pos.y;
    const d = Math.hypot(dx, dy);
    if (d > 8) {
      p.desired = { x: dx / d, y: dy / d };
      p.lookDir = null;
      p.step(dt, p.baseSpeed * 0.45); // a relaxed walk back
      p.pos.y = this.app.field.clampY(p.pos.y);
    } else {
      p.desired = { x: 0, y: 0 };
      p.step(dt, 0);
    }
  }

  /** Place a loose huddle a few yards behind the dead-ball spot (offense side) and let
   * the defense drift to their side, clamped to the field. */
  private computeRegroupTargets(): void {
    const targets = new Map<Player, Vec2>();
    const f = this.app.field;
    const cy = f.maxY / 2;
    const clampX = (x: number) => Math.max(LEFT_GOAL_X + 16, Math.min(RIGHT_GOAL_X - 16, x));
    const huddleX = clampX(this.endSpot.x - this.dir * PX_PER_YARD * 7);
    this.offense.forEach((o, i) => {
      const ang = (i / this.offense.length) * Math.PI * 2;
      targets.set(o, { x: huddleX + Math.cos(ang) * PX_PER_YARD * 2, y: cy + Math.sin(ang) * PX_PER_YARD * 2 });
    });
    const defX = clampX(this.endSpot.x + this.dir * PX_PER_YARD * 6);
    this.defense.forEach((dpl, i) => {
      targets.set(dpl, { x: defX, y: f.clampY(cy + (i - this.defense.length / 2) * PX_PER_YARD * 4) });
    });
    this.regroupTargets = targets;
  }

  private committed = false;
  private commitOutcome(): void {
    if (this.committed || !this.playResult) return;
    this.committed = true;
    const m = this.app.match;
    const res = this.playResult;
    if (m.practice) {
      // Sandbox: no game-over / PAT / kickoff. Hand the ball off at midfield after a score (so you
      // rep the other side too); otherwise keep the live down + possession the play left — turnovers
      // included — and drop straight back into the play-call. Same mechanics, no ceremony.
      const mid = (LEFT_GOAL_X + RIGHT_GOAL_X) / 2;
      if (res.touchdown && res.scoringTeam) m.startSeries(m.opponent(res.scoringTeam), mid);
      else if (res.kickoff && res.kickReceiver) m.startSeries(res.kickReceiver, mid);
      this.enterPlayCall();
      return;
    }
    if (m.isOver) {
      this.app.audio.stopCrowd();
      this.app.setState(new GameOverState(this.app));
    } else if (res.touchdown && res.scoringTeam) {
      // A touchdown: the scoring team chooses the extra point or a two-point try, then kicks off.
      this.app.audio.stopCrowd();
      this.app.setState(new PatChoiceState(this.app, res.scoringTeam));
    } else if (res.kickoff && res.kickReceiver) {
      // A score is its own sequence (kickoff/return); cut to it.
      this.app.audio.stopCrowd();
      this.app.setState(new KickoffState(this.app, res.kickReceiver));
    } else if (m.down === 4 && !res.changedPossession && !res.scored) {
      // The offense faces 4th down: go for it, punt, or try a field goal.
      this.app.audio.stopCrowd();
      this.app.setState(new FourthDownState(this.app));
    } else {
      // Normal play-to-play (incl. turnovers on the field): stay mounted and bring up the
      // play-call as a broadcast overlay while players jog back to the huddle behind it.
      this.enterPlayCall();
    }
  }

  private spawnTurboTrail(): void {
    const c = this.controlled;
    if (!c || c.isDown || !c.turbo) return;
    const sp = Math.hypot(c.vel.x, c.vel.y);
    if (sp < 50) return;
    // Stream embers off the trailing foot (just behind the run direction).
    const bx = c.pos.x - (c.vel.x / sp) * 9;
    const by = c.pos.y - (c.vel.y / sp) * 9;
    this.app.particles.trail(bx, by);
    this.app.particles.trail(bx, by);
  }

  private fireFxTick = 0;
  private spawnFireFx(): void {
    const m = this.app.match;
    this.fireFxTick++;
    for (const p of this.all) {
      if (p.isDown || !m.team(p.team).onFire) continue;
      const lead = p.hasBall || p.controlled;
      if (lead) {
        // A bright flame aura on the hot ball-carrier.
        this.app.particles.fire(p.pos.x, p.pos.y + p.radius * 0.4, 2, 0.7);
      } else if (this.fireFxTick % 2 === 0) {
        // Every on-fire teammate smolders too (staggered to stay cheap) — the WHOLE team is lit,
        // not just the runner.
        this.app.particles.fire(p.pos.x, p.pos.y + p.radius * 0.4, 1, 0.5);
      }
    }
  }

  // --- render ---------------------------------------------------------------

  render(alpha = 1): void {
    const app = this.app;
    const r = app.r;
    const m = app.match;

    app.scene3d.render(alpha);

    // Cinematic letterbox over the field (eases in for the replay, out when it closes).
    this.drawLetterbox(r);

    // Replay takes over the screen with its own clean broadcast UI.
    if (this.phase === "replay") {
      this.renderReplay(r);
      return;
    }

    // FX and UI are drawn on the transparent 2D overlay above the 3D scene.
    const project = this.project;
    app.particles.render(r, project);

    // 1-on-1 tackle battle UI over the locked combatants.
    if (this.phase === "struggle") {
      app.floating.render(r, project);
      this.renderStruggle(r);
      return;
    }
    this.renderPassHints(r);
    this.renderThrowMeter(r);
    app.floating.render(r, project);

    const myTeam = m.team(m.humanTeam);
    this.hud.render(r, m, {
      turbo: this.turbo,
      fire: { meter: myTeam.fireMeter, onFire: myTeam.onFire },
      possessionLabel: this.phase === "presnap" ? this.preSnapLabel() : undefined,
      playClock: this.phase === "presnap" ? this.snapTimer : undefined,
      minimal: this.phase === "live", // strip the board down during the snap
    });

    if (this.phase === "dead") {
      this.renderResultBanner(r);
      this.renderReplayButton(r);
    } else if (this.phase === "playcall") {
      // Broadcast-style call over the live field (players jogging back to the huddle behind it). The
      // result banner is NOT drawn here — it already held for the whole dead beat, and drawing it
      // under the "CALL IT" header stacked the two on top of each other (unreadable). Cards only.
      this.renderReplayButton(r);
      this.playCall.render(r, { alpha: this.playCallT });
      if (this.app.match.practice) {
        drawButton(r, this.practiceExitRect, "‹ EXIT", { fill: COLORS.concrete, size: 13 });
        r.text("PRACTICE", r.width / 2, this.practiceExitRect.y + 6, { size: 13, align: "center", color: COLORS.hazard, font: FONT.ui });
      }
    } else {
      app.input.setLayout(this.controls.computeLayout(r, app.match.debugMode));
      this.controls.render(r, app.input, this.controlLabels());
    }

    this.renderQuarterBanner(r);
  }

  /** Tecmo-style tug-of-war UI: a meter the human fills by mashing, with a TAP prompt + timer. */
  private renderStruggle(r: Renderer): void {
    const ctx = r.ctx;
    const W = r.width;
    const cx = W / 2;
    const y = r.height * 0.3;
    const carrierWins = this.struggleHumanCarrier;
    const carrierCol = this.struggleCarrier ? `#${this.colorFor(this.struggleCarrier).jersey.toString(16).padStart(6, "0")}` : "#1fd17a";
    const tacklerCol = this.struggleTackler ? `#${this.colorFor(this.struggleTackler).jersey.toString(16).padStart(6, "0")}` : "#e23b3b";

    // Prompt.
    r.text(carrierWins ? "BREAK THE TACKLE!" : "MAKE THE TACKLE!", cx, y - 34, { size: 24, align: "center", color: COLORS.bone, baseline: "middle", font: FONT.display });

    // Tug bar: left = tackler, right = carrier; the divider sits at struggleVal.
    const bw = Math.min(440, W - 56);
    const bx = cx - bw / 2;
    const bh = 34;
    const div = bx + bw * this.struggleVal;
    ctx.save();
    roundRect(ctx, bx - 3, y - 3, bw + 6, bh + 6, 10);
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fill();
    ctx.fillStyle = tacklerCol;
    roundRect(ctx, bx, y, div - bx, bh, 8);
    ctx.fill();
    ctx.fillStyle = carrierCol;
    roundRect(ctx, div, y, bx + bw - div, bh, 8);
    ctx.fill();
    // Divider handle + flash on mash.
    ctx.globalAlpha = 0.6 + 0.4 * this.struggleFlash;
    ctx.fillStyle = "#fff";
    ctx.fillRect(div - 3, y - 6, 6, bh + 12);
    ctx.restore();
    r.text("TACKLER", bx + 4, y + bh + 14, { size: 11, color: COLORS.ash, baseline: "middle", font: FONT.ui });
    r.text("CARRIER", bx + bw - 4, y + bh + 14, { size: 11, align: "right", color: COLORS.ash, baseline: "middle", font: FONT.ui });

    // Timer bar.
    const tf = Math.max(0, this.struggleTimer / STRUGGLE_TIME);
    ctx.fillStyle = "rgba(255,255,255,0.18)";
    ctx.fillRect(bx, y - 12, bw, 4);
    ctx.fillStyle = COLORS.hazard;
    ctx.fillRect(bx, y - 12, bw * tf, 4);

    // Mash prompt (pulsing).
    const pulse = 0.5 + 0.5 * Math.sin(this.playTime * 22);
    r.text("TAP!  TAP!  TAP!", cx, y + bh + 44, { size: 22 + pulse * 6, align: "center", color: COLORS.hazard, baseline: "middle", alpha: 0.7 + 0.3 * this.struggleFlash, font: FONT.display });
  }

  /** The "▶ REPLAY" button shown after a play (top-left, clear of the result banner + cards). */
  private renderReplayButton(r: Renderer): void {
    if (!this.replay.available) { this.replayBtn = { x: 0, y: 0, w: 0, h: 0 }; return; }
    const w = Math.min(132, r.width * 0.3);
    this.replayBtn = { x: 12, y: 56, w, h: 38 };
    drawButton(r, this.replayBtn, "▶ REPLAY", { fill: COLORS.concrete, accent: COLORS.hazard, size: 15 });
  }

  /** Cinematic black bars (top + bottom) with a thin accent edge, scaled by `this.letterbox`. */
  private drawLetterbox(r: Renderer): void {
    if (this.letterbox <= 0.001) return;
    const ctx = r.ctx;
    const barH = Math.round(r.height * 0.11 * this.letterbox);
    if (barH <= 0) return;
    ctx.save();
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, r.width, barH);
    ctx.fillRect(0, r.height - barH, r.width, barH);
    ctx.fillStyle = COLORS.blood;
    ctx.globalAlpha = this.letterbox;
    ctx.fillRect(0, barH - 2, r.width, 2);
    ctx.fillRect(0, r.height - barH, r.width, 2);
    ctx.restore();
  }

  /** A pulsing broadcast "● INSTANT REPLAY" tag, centered in the top letterbox bar. */
  private renderReplayTag(r: Renderer): void {
    const ctx = r.ctx;
    const y = Math.round(r.height * 0.055);
    const pulse = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(performance.now() / 240));
    ctx.save();
    ctx.fillStyle = `rgba(230,40,40,${pulse.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(r.width / 2 - 78, y, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    r.text("INSTANT REPLAY", r.width / 2 + 6, y, { size: 17, align: "center", color: COLORS.bone, baseline: "middle", font: FONT.display });
  }

  /** The instant-replay overlay: scrub slider, play/pause, zoom, close, and a time/zoom readout. */
  private renderReplay(r: Renderer): void {
    const ctx = r.ctx;
    const W = r.width;
    const H = r.height;
    const dur = this.replay.duration || 1;

    // Broadcast tag sits in the top letterbox bar.
    this.renderReplayTag(r);

    // An automatic (touchdown) replay is hands-off: no transport, just a skip hint.
    if (this.replayAuto) {
      const a = 0.45 + 0.45 * Math.sin(performance.now() / 320);
      r.text("TAP TO SKIP", W / 2, H - Math.round(H * 0.055), { size: 14, align: "center", color: COLORS.bone, baseline: "middle", alpha: a, font: FONT.display });
      return;
    }

    // Keep the replay controls clear of notches / the home indicator on phones.
    const sa = r.safe;
    this.rcClose = { x: W - 56 - sa.right, y: 8 + sa.top, w: 44, h: 32 };
    drawButton(r, this.rcClose, "✕", { fill: COLORS.blood, size: 18 });

    // Zoom buttons (right side).
    const zb = 44;
    this.rcZoomIn = { x: W - zb - 12 - sa.right, y: H * 0.4, w: zb, h: zb };
    this.rcZoomOut = { x: W - zb - 12 - sa.right, y: H * 0.4 + zb + 10, w: zb, h: zb };
    drawButton(r, this.rcZoomIn, "+", { fill: COLORS.concrete, size: 24 });
    drawButton(r, this.rcZoomOut, "–", { fill: COLORS.concrete, size: 24 });

    // Bottom transport: play/pause + scrub slider.
    const by = H - 56 - sa.bottom;
    this.rcPlay = { x: 14 + sa.left, y: by - 6, w: 56, h: 48 };
    drawButton(r, this.rcPlay, this.replayPlaying ? "❚❚" : "▶", { fill: COLORS.concrete, accent: COLORS.hazard, size: 18 });

    const sx = 84 + sa.left;
    const sw = W - sx - 14 - zb - 16 - sa.right;
    const sliderY = by + 14;
    this.rcSlider = { x: sx, y: sliderY, w: sw, h: 14 };
    // Track + progress + handle.
    ctx.save();
    ctx.fillStyle = "rgba(255,255,255,0.18)";
    roundRect(ctx, sx, sliderY, sw, 6, 3);
    ctx.fill();
    const frac = Math.max(0, Math.min(1, this.replayT / dur));
    ctx.fillStyle = COLORS.hazard;
    roundRect(ctx, sx, sliderY, sw * frac, 6, 3);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(sx + sw * frac, sliderY + 3, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    r.text(`${this.replayT.toFixed(1)}s / ${dur.toFixed(1)}s`, sx, sliderY - 16, { size: 12, color: COLORS.ash, baseline: "bottom", font: FONT.ui });
  }

  /** On-field result banner during the post-play beat (replaces the old banner screen). */
  private renderResultBanner(r: Renderer, showTapPrompt = true): void {
    if (!this.pendingOutcome) return;
    const res = this.playResult;
    // A score gets a dramatic celebration beat (glow + the updated scoreboard), not the plain bar.
    if (res?.scored && res.scoringTeam) { this.renderScoreCelebration(r, showTapPrompt); return; }
    const w = Math.min(440, r.width - 48);
    const h = 92;
    const x = (r.width - w) / 2;
    const y = 54;
    drawPanel(r, { x, y, w, h });
    const ctx = r.ctx;
    ctx.save();
    ctx.letterSpacing = "1px";
    r.text(this.pendingOutcome.headline.toUpperCase(), r.width / 2, y + 34, {
      size: 30,
      align: "center",
      color: COLORS.bone,
      baseline: "middle",
      font: FONT.display,
    });
    ctx.restore();
    r.text(this.resultDetail, r.width / 2, y + 68, { size: 17, align: "center", color: COLORS.blood, baseline: "middle", font: FONT.ui });
    if (!showTapPrompt) return;
    const a = 0.5 + 0.5 * Math.sin(this.deadElapsed * 4);
    r.text("TAP TO CONTINUE", r.width / 2, r.height - 24, {
      size: 15,
      align: "center",
      color: COLORS.bone,
      baseline: "middle",
      alpha: a,
      font: FONT.display,
    });
  }

  /** Big score celebration beat: glowing headline + the team and the updated scoreboard. */
  private renderScoreCelebration(r: Renderer, showTapPrompt: boolean): void {
    const m = this.app.match;
    const team = m.team(this.playResult!.scoringTeam!);
    const ctx = r.ctx;
    const t = this.deadElapsed;
    const pulse = 0.85 + 0.15 * Math.sin(t * 6);
    const w = Math.min(460, r.width - 32);
    const h = 132;
    const x = (r.width - w) / 2;
    const y = 48;
    ctx.save();
    // Glowing plate in the scoring team's color.
    ctx.shadowColor = team.colors.jersey;
    ctx.shadowBlur = 24 * pulse;
    drawPanel(r, { x, y, w, h }, COLORS.bg1);
    ctx.restore();

    ctx.save();
    ctx.letterSpacing = "2px";
    const head = this.pendingOutcome!.headline.toUpperCase();
    // Pop the headline in over the first beat.
    const grow = Math.min(1, t * 5);
    r.text(head, r.width / 2, y + 42, { size: 28 + 16 * grow, align: "center", color: team.colors.jersey, baseline: "middle", font: FONT.display, alpha: pulse });
    ctx.restore();
    r.text(team.config.name.toUpperCase(), r.width / 2, y + 76, { size: 15, align: "center", color: COLORS.bone, baseline: "middle", weight: "normal", font: FONT.ui });
    // Updated scoreboard line.
    r.text(`${m.home.config.abbr} ${m.home.score}   —   ${m.away.score} ${m.away.config.abbr}`, r.width / 2, y + 106, {
      size: 26, align: "center", color: COLORS.bone, baseline: "middle", font: FONT.display,
    });

    if (!showTapPrompt) return;
    const a = 0.5 + 0.5 * Math.sin(this.deadElapsed * 4);
    r.text("TAP TO CONTINUE", r.width / 2, r.height - 24, { size: 15, align: "center", color: COLORS.bone, baseline: "middle", alpha: a, font: FONT.display });
  }

  /** Pre-snap HUD prompt: break-the-huddle while walking, hike prompt once set. */
  private preSnapLabel(): string {
    if (!this.humanIsOffense) {
      return this.preSnapReady ? "DEFENSE — TAP TO SWITCH" : "DEFENSE — BREAK THE HUDDLE";
    }
    return this.preSnapReady ? "TAP ACTION TO HIKE" : "BREAKING THE HUDDLE…";
  }

  /** Projector bound to the 3D camera, for overlay FX/text. */
  private project = (x: number, y: number, h: number) => this.app.scene3d.project(x, y, h);

  /** Reticles over eligible receivers (green=open) + a highlight on the target. */
  private renderPassHints(r: Renderer): void {
    // Only once the ball is snapped (live), the QB still holds it behind the line on a pass play,
    // and hasn't thrown — i.e. exactly when he can legally throw. Hidden pre-snap, on runs, and the
    // instant he scrambles across the line of scrimmage.
    if (!this.humanIsOffense || this.phase !== "live" || !this.qb || !this.canThrow(this.qb)) return;
    const ctx = r.ctx;
    const eligible = this.offense.filter((p) => p.role !== "QB" && p.job !== "block" && !p.isDown);
    const choice = chooseTarget(this.qb, this.offense.filter((p) => p.role !== "QB"), this.defense, this.dir, this.stickToField());
    const target = choice?.receiver ?? null;

    for (const rcv of eligible) {
      const s = this.app.scene3d.project(rcv.pos.x, rcv.pos.y, 80);
      if (!s.visible) continue;
      const open = this.nearestDefDist(rcv);
      const color = open > 78 ? "#5dff7a" : open > 44 ? "#ffd23a" : "#ff5a5a";
      const isTarget = rcv === target;
      const size = isTarget ? 13 : 8;
      const y = s.y - (isTarget ? 4 : 0);
      ctx.save();
      ctx.globalAlpha = isTarget ? 1 : 0.75;
      ctx.fillStyle = color;
      ctx.strokeStyle = "rgba(0,0,0,0.6)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(s.x, y + size);
      ctx.lineTo(s.x - size * 0.8, y);
      ctx.lineTo(s.x + size * 0.8, y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      if (isTarget) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(s.x, y - 1, size + 6, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  /** A charging-throw power bar above the QB: green lob -> red bullet as you hold. */
  private renderThrowMeter(r: Renderer): void {
    if (!this.throwCharging || !this.qb) return;
    const t = clamp(this.throwCharge / THROW_CHARGE_MAX, 0, 1);
    const s = this.app.scene3d.project(this.qb.pos.x, this.qb.pos.y, 130);
    if (!s.visible) return;
    const ctx = r.ctx;
    const w = 56;
    const h = 8;
    const x = s.x - w / 2;
    const y = s.y - 34;
    const cr = Math.round(lerp(80, 255, t));
    const cg = Math.round(lerp(230, 80, t));
    const cb = Math.round(lerp(160, 40, t));
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(x - 2, y - 2, w + 4, h + 4);
    ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
    ctx.fillRect(x, y, w * t, h);
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = 1;
    ctx.strokeRect(x - 2, y - 2, w + 4, h + 4);
    ctx.fillStyle = "#fff";
    ctx.font = 'bold 11px "Trebuchet MS", system-ui, sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText(t > 0.66 ? "BULLET" : t < 0.33 ? "LOB" : "PASS", s.x, y - 4);
    ctx.restore();
  }

  private nearestDefDist(p: Player): number {
    let m = Infinity;
    for (const d of this.defense) {
      if (d.isDown) continue;
      const dd = dist(d.pos, p.pos);
      if (dd < m) m = dd;
    }
    return m;
  }

  /** The single ACTION button morphs by situation (the rest is procedural in the
   * control handlers). Keep this label in sync with what ACTION actually does. */
  private controlLabels(): ControlLabels {
    const blue = "#1c6fd0";
    const green = "#1f9d4d";
    const grey = "#5a6b7a";

    if (this.phase === "presnap") {
      return this.humanIsOffense
        ? { action: { text: "HIKE", icon: "pass", color: green } }
        : { action: { text: "SWITCH", icon: "switch", color: blue } };
    }

    if (this.humanIsOffense) {
      const c = this.controlled;
      if (c && this.canThrow(c)) return { action: { text: "PASS", icon: "pass", color: blue } };
      if (c && this.ball.carrier === c) {
        const d = this.nearestTackler(c, 72);
        const text = d && this.isAhead(c, d) ? "STIFF ARM" : "SPIN";
        return { action: { text, icon: "spin", color: green } };
      }
      if (this.ball.state === "inAir") return { action: { text: "CATCH", icon: "pass", color: green } };
      return { action: { text: "—", icon: "switch", color: grey } };
    }

    // Defense: a committed BIG HIT when on the carrier, otherwise switch.
    if (this.controlled && this.defenderInTackleRange(this.controlled)) {
      return { action: { text: "BIG HIT", icon: "tackle", color: "#d23a2a" } };
    }
    return { action: { text: "SWITCH", icon: "switch", color: blue } };
  }

  exit(): void {
    this.app.audio.stopCrowd();
    // Tear down the replay free-look (removes its DOM overlay + toggle button) and restore the cam.
    this.freeCam?.dispose();
    this.freeCam = null;
    this.app.scene3d.freeCam = false;
  }
}

/** Convert a "#rrggbb" CSS color to a numeric hex for Three.js materials. */
function hexNum(css: string): number {
  return parseInt(css.replace("#", ""), 16);
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, h / 2, w / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function ordinal(n: number): string {
  return n === 1 ? "1ST" : n === 2 ? "2ND" : n === 3 ? "3RD" : `${n}TH`;
}

function headlineFor(type: OutcomeType, yards: number): string {
  switch (type) {
    case "touchdown":
      return "TOUCHDOWN!";
    case "interception":
      return "INTERCEPTED!";
    case "fumbleLost":
      return "FUMBLE — TURNOVER!";
    case "safety":
      return "SAFETY!";
    case "sack":
      return `SACKED! ${yards} yd`;
    case "incomplete":
      return "INCOMPLETE";
    case "outOfBounds":
      return `OUT OF BOUNDS · ${yards >= 0 ? "+" : ""}${yards} yd`;
    default:
      return `${yards >= 0 ? "+" : ""}${yards} yd`;
  }
}
