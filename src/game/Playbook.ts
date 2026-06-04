import { Player, type Role, type TeamId } from "./entities/Player";
import { FIELD_WIDTH, PX_PER_YARD } from "./Field";

/**
 * Plays are authored in field-relative units (yards): `fwd` = yards downfield along
 * the offense's attack direction from the line of scrimmage; `lat` = yards from the
 * field's center line (positive = toward +Y sideline). A small builder converts a
 * chosen play + LOS + attack direction into concrete `Player` rosters with routes.
 */
export interface RelPoint {
  fwd: number;
  lat: number;
}

interface OffSlot {
  role: Role;
  number: number;
  start: RelPoint;
  /** Receiver route waypoints; empty = blocker/QB/runner handled by job. */
  route?: RelPoint[];
  job: "qb" | "run" | "route" | "block";
}

export interface OffensePlay {
  id: string;
  name: string;
  blurb: string;
  isRun: boolean;
  slots: OffSlot[];
}

export type DefenseScheme = "cover" | "blitz" | "spy";

export interface DefensePlay {
  id: string;
  name: string;
  blurb: string;
  scheme: DefenseScheme;
}

const CENTER_Y = FIELD_WIDTH / 2;

// Shared offensive line + backfield used by most plays.
const BASE_OL: OffSlot[] = [
  { role: "OL", number: 76, start: { fwd: 0, lat: -2.5 }, job: "block" },
  { role: "OL", number: 64, start: { fwd: 0, lat: 2.5 }, job: "block" },
];

export const OFFENSE_PLAYS: OffensePlay[] = [
  {
    id: "slants",
    name: "SLANTS",
    blurb: "Quick crossing routes. Beat the blitz.",
    isRun: false,
    slots: [
      { role: "QB", number: 7, start: { fwd: -4, lat: 0 }, job: "qb" },
      { role: "HB", number: 28, start: { fwd: -6, lat: -2 }, job: "route", route: [
        { fwd: 1, lat: -10 }, { fwd: 4, lat: -15 },
      ] },
      { role: "WR", number: 11, start: { fwd: 0, lat: -17 }, job: "route", route: [
        { fwd: 7, lat: -10 }, { fwd: 14, lat: -2 },
      ] },
      { role: "WR", number: 84, start: { fwd: 0, lat: 17 }, job: "route", route: [
        { fwd: 7, lat: 10 }, { fwd: 14, lat: 2 },
      ] },
      { role: "WR", number: 19, start: { fwd: 0, lat: 8 }, job: "route", route: [
        { fwd: 5, lat: 14 }, { fwd: 6, lat: 20 },
      ] },
      ...BASE_OL,
    ],
  },
  {
    id: "streaks",
    name: "STREAKS",
    blurb: "Go deep. Take the top off.",
    isRun: false,
    slots: [
      { role: "QB", number: 7, start: { fwd: -4, lat: 0 }, job: "qb" },
      { role: "HB", number: 28, start: { fwd: -6, lat: 2 }, job: "route", route: [
        { fwd: 2, lat: 12 }, { fwd: 4, lat: 16 },
      ] },
      { role: "WR", number: 11, start: { fwd: 0, lat: -18 }, job: "route", route: [
        { fwd: 22, lat: -18 }, { fwd: 45, lat: -16 },
      ] },
      { role: "WR", number: 84, start: { fwd: 0, lat: 18 }, job: "route", route: [
        { fwd: 22, lat: 18 }, { fwd: 45, lat: 16 },
      ] },
      { role: "WR", number: 19, start: { fwd: 0, lat: 7 }, job: "route", route: [
        { fwd: 14, lat: 4 }, { fwd: 28, lat: 0 },
      ] },
      ...BASE_OL,
    ],
  },
  {
    id: "hbdive",
    name: "HB DIVE",
    blurb: "Hand it off. Smash-mouth run.",
    isRun: true,
    slots: [
      { role: "QB", number: 7, start: { fwd: -4, lat: 0 }, job: "qb" },
      { role: "HB", number: 28, start: { fwd: -6, lat: 0 }, job: "run" },
      { role: "WR", number: 11, start: { fwd: 0, lat: -18 }, job: "block" },
      { role: "WR", number: 84, start: { fwd: 0, lat: 18 }, job: "block" },
      { role: "WR", number: 19, start: { fwd: 0, lat: 8 }, job: "block" },
      ...BASE_OL,
    ],
  },
  {
    id: "hailmary",
    name: "HAIL MARY",
    blurb: "Everyone go. Heave it.",
    isRun: false,
    slots: [
      { role: "QB", number: 7, start: { fwd: -5, lat: 0 }, job: "qb" },
      { role: "HB", number: 28, start: { fwd: -6, lat: 3 }, job: "route", route: [
        { fwd: 30, lat: 6 }, { fwd: 50, lat: 8 },
      ] },
      { role: "WR", number: 11, start: { fwd: 0, lat: -16 }, job: "route", route: [
        { fwd: 30, lat: -12 }, { fwd: 52, lat: -6 },
      ] },
      { role: "WR", number: 84, start: { fwd: 0, lat: 16 }, job: "route", route: [
        { fwd: 30, lat: 12 }, { fwd: 52, lat: 6 },
      ] },
      { role: "WR", number: 19, start: { fwd: 0, lat: 6 }, job: "route", route: [
        { fwd: 30, lat: 0 }, { fwd: 52, lat: 0 },
      ] },
      ...BASE_OL,
    ],
  },
];

export const DEFENSE_PLAYS: DefensePlay[] = [
  { id: "cover", name: "COVER", blurb: "Man up. Bend, don't break.", scheme: "cover" },
  { id: "blitz", name: "BLITZ", blurb: "Send the house. Sack the QB.", scheme: "blitz" },
  { id: "spy", name: "SPY", blurb: "Contain the run. Watch the QB.", scheme: "spy" },
];

/** Fixed defensive alignment (7): 2 DL, 2 LB, 3 DB. */
const DEF_SLOTS: { role: Role; number: number; start: RelPoint }[] = [
  { role: "DL", number: 99, start: { fwd: 1.5, lat: -2 } },
  { role: "DL", number: 92, start: { fwd: 1.5, lat: 2 } },
  { role: "LB", number: 54, start: { fwd: 5, lat: -6 } },
  { role: "LB", number: 50, start: { fwd: 5, lat: 6 } },
  { role: "DB", number: 24, start: { fwd: 7, lat: -16 } },
  { role: "DB", number: 21, start: { fwd: 7, lat: 16 } },
  { role: "DB", number: 31, start: { fwd: 13, lat: 0 } },
];

function relToWorld(losX: number, dir: number, p: RelPoint): { x: number; y: number } {
  return { x: losX + dir * p.fwd * PX_PER_YARD, y: CENTER_Y + p.lat * PX_PER_YARD };
}

/** Build the 7 offensive players for a play at the given LOS and attack direction. */
export function buildOffense(
  play: OffensePlay,
  team: TeamId,
  losX: number,
  dir: number,
): Player[] {
  return play.slots.map((slot) => {
    const w = relToWorld(losX, dir, slot.start);
    const p = new Player(team, slot.role, slot.number, w.x, w.y);
    p.home = { x: w.x, y: w.y };
    p.facing = dir > 0 ? 0 : Math.PI;
    p.job = slot.job;
    if (slot.route) {
      p.route = slot.route.map((r) => relToWorld(losX, dir, r));
    }
    return p;
  });
}

/** Build the 7 defensive players. Coverage assignment is resolved by DefenseAI. */
export function buildDefense(team: TeamId, losX: number, dir: number): Player[] {
  return DEF_SLOTS.map((slot) => {
    const w = relToWorld(losX, dir, slot.start);
    const p = new Player(team, slot.role, slot.number, w.x, w.y);
    p.home = { x: w.x, y: w.y };
    p.facing = dir > 0 ? Math.PI : 0;
    return p;
  });
}
