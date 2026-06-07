import type { TeamId } from "./entities/Player";
import type { EmblemIcon } from "../ui/Emblems";

export interface TeamColors {
  /** Primary jersey base color. */
  jersey: string;
  /** Dark helmet / pants color. */
  trim: string;
  /** Bright contrast color for sleeve stripes, collar, and number outlines. */
  accent: string;
}

export interface TeamConfig {
  id: TeamId;
  name: string;
  abbr: string;
  icon: EmblemIcon;
  colors: TeamColors;
}

/** Fictional teams (no licensing). Picked on the team-select screen. */
export const TEAMS: TeamConfig[] = [
  { id: "HOME", name: "Neon Bolts", abbr: "NB", icon: "bolt", colors: { jersey: "#ffd23a", trim: "#14162e", accent: "#1b2f7a" } },
  { id: "HOME", name: "Crimson Rhinos", abbr: "CR", icon: "horn", colors: { jersey: "#e23b3b", trim: "#2a0a0a", accent: "#f2c14e" } },
  { id: "HOME", name: "Azure Sharks", abbr: "AZ", icon: "fin", colors: { jersey: "#27a3ff", trim: "#06243b", accent: "#ff8a1e" } },
  { id: "HOME", name: "Emerald Hawks", abbr: "EH", icon: "wing", colors: { jersey: "#1fd17a", trim: "#063b22", accent: "#0b2e44" } },
  { id: "HOME", name: "Violet Vipers", abbr: "VV", icon: "viper", colors: { jersey: "#9b5cff", trim: "#1c0a3b", accent: "#ffd23a" } },
  { id: "HOME", name: "Orange Crush", abbr: "OC", icon: "star", colors: { jersey: "#ff7b1e", trim: "#2a1402", accent: "#1a2440" } },
];

/** How long ON FIRE lasts on a full meter with no further good plays. */
const FIRE_BURN_SECONDS = 24;

/**
 * Live per-game team state: score and the Blitz-style ON FIRE meter.
 *
 * Fire is BUILT UP from consecutive good plays (first downs, explosive gains, sacks, takeaways,
 * stops). `fireMeter` (0..1) fills with each good play and snuffs back down on a bad one; when it
 * tops out the WHOLE team catches fire — faster, near-unlimited turbo — until it burns out (good
 * plays refuel it) or the opponent scores.
 */
export class Team {
  readonly config: TeamConfig;
  score = 0;
  onFire = false;
  /** 0..1 — the build-up gauge toward ON FIRE, and (while lit) the burn-down that good plays refuel. */
  fireMeter = 0;

  constructor(config: TeamConfig) {
    this.config = config;
  }

  get colors(): TeamColors {
    return this.config.colors;
  }

  /** Reward a good play. While building it fills the meter (igniting at full); while lit it refuels
   *  the burn. Returns true only on the play that ignites the team. */
  addFire(amount: number): boolean {
    if (this.onFire) {
      this.fireMeter = Math.min(1, this.fireMeter + amount * 1.3); // good plays keep the fire stoked
      return false;
    }
    this.fireMeter = Math.min(1, this.fireMeter + amount);
    if (this.fireMeter >= 1) {
      this.onFire = true;
      this.fireMeter = 1;
      return true;
    }
    return false;
  }

  /** A bad play (sack / turnover / 3-and-out) breaks the streak — the build resets. An already-lit
   *  fire keeps burning (only the opponent scoring or time puts it out). */
  breakStreak(): void {
    if (!this.onFire) this.fireMeter = 0;
  }

  extinguish(): void {
    this.onFire = false;
    this.fireMeter = 0;
  }

  update(dt: number): void {
    if (this.onFire) {
      this.fireMeter -= dt / FIRE_BURN_SECONDS;
      if (this.fireMeter <= 0) this.extinguish();
    }
  }
}
