import type { TeamId } from "./entities/Player";
import type { EmblemIcon } from "../ui/Emblems";

export interface TeamColors {
  jersey: string;
  trim: string;
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
  { id: "HOME", name: "Neon Bolts", abbr: "NB", icon: "bolt", colors: { jersey: "#ffd23a", trim: "#1a1a2e" } },
  { id: "HOME", name: "Crimson Rhinos", abbr: "CR", icon: "horn", colors: { jersey: "#e23b3b", trim: "#2a0a0a" } },
  { id: "HOME", name: "Azure Sharks", abbr: "AZ", icon: "fin", colors: { jersey: "#27a3ff", trim: "#06243b" } },
  { id: "HOME", name: "Emerald Hawks", abbr: "EH", icon: "wing", colors: { jersey: "#1fd17a", trim: "#063b22" } },
  { id: "HOME", name: "Violet Vipers", abbr: "VV", icon: "viper", colors: { jersey: "#9b5cff", trim: "#1c0a3b" } },
  { id: "HOME", name: "Orange Crush", abbr: "OC", icon: "star", colors: { jersey: "#ff7b1e", trim: "#3b1c06" } },
];

/**
 * Live per-game team state: score, timeouts, and the Blitz-style ON FIRE meter.
 * On fire is earned by consecutive big defensive/offensive feats and boosts the
 * whole team until the opponent scores.
 */
export class Team {
  readonly config: TeamConfig;
  score = 0;
  onFire = false;
  fireTimer = 0;
  /** Streak counters that can trigger ON FIRE (e.g. consecutive sacks/conversions). */
  streak = 0;

  constructor(config: TeamConfig) {
    this.config = config;
  }

  get colors(): TeamColors {
    return this.config.colors;
  }

  igniteIfReady(): boolean {
    if (this.streak >= 2 && !this.onFire) {
      this.onFire = true;
      this.fireTimer = 30; // safety expiry; normally cleared when opponent scores
      return true;
    }
    return false;
  }

  extinguish(): void {
    this.onFire = false;
    this.fireTimer = 0;
    this.streak = 0;
  }

  update(dt: number): void {
    if (this.onFire) {
      this.fireTimer -= dt;
      if (this.fireTimer <= 0) this.extinguish();
    }
  }
}
