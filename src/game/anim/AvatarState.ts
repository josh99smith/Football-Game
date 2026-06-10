/**
 * Formal animation states for the on-field avatar. They replace the implicit flag soup
 * (`rPhase` / `oneShot` / `fallT` / `suppressFall`) with an explicit vocabulary the renderer derives
 * each frame — the foundation for transition-enforced channel ownership, so an overlay or fall can
 * never leak weight across states (the bug class behind the locomotion corruption we fixed).
 *
 * Kept dependency-free (no Three.js) so the renderer and a future debug panel can both read it.
 */
export type AvatarState = "loco" | "action" | "contact" | "down" | "ragFall" | "getup";

/** Per-frame signals the avatar state is derived from. */
export interface AvatarSignals {
  /** A physics ragdoll owns the body (rPhase "fall"). */
  ragdolling: boolean;
  /** Standing back up after a ragdoll settled (rPhase "getup"). */
  gettingUp: boolean;
  /** A one-shot clip or the procedural throw is overlaying locomotion. */
  overlay: boolean;
  /** Fully tackled / flattening (loco.down). */
  down: boolean;
  /** Wrapped up in the contact beat, still upright (loco.contact). */
  contact: boolean;
}

/**
 * Derive the avatar state from this frame's signals. Priority: physics owns the body first, then an
 * active overlay, then the ground state, else normal locomotion.
 */
export function deriveAvatarState(s: AvatarSignals): AvatarState {
  if (s.ragdolling) return "ragFall";
  if (s.gettingUp) return "getup";
  if (s.overlay) return "action";
  if (s.down) return "down";
  if (s.contact) return "contact";
  return "loco";
}
