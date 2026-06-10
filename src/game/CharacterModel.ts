import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";

export interface CharacterClips {
  /** Football ready stance / default idle (used by everyone when set). */
  idle: THREE.AnimationClip | null;
  /** Forward run (locomotion). */
  run: THREE.AnimationClip | null;
  /** Backpedal (moving opposite facing). */
  runBack: THREE.AnimationClip | null;
  /** Lateral shuffle (moving sideways relative to facing). */
  strafe: THREE.AnimationClip | null;
  /** Diagonal backpedal jog — defenders shuffling back in coverage. */
  backDiag: THREE.AnimationClip | null;
  /** One-shot QB throw. */
  pass: THREE.AnimationClip | null;
  /** One-shot reception. */
  catch: THREE.AnimationClip | null;
  /** One-shot plant-and-cut (juke). */
  juke: THREE.AnimationClip | null;
  /** Walk cycle (slow locomotion / breaking the huddle). */
  walk: THREE.AnimationClip | null;
  /** One-shot getting-tackled / fall reaction (the ball carrier). */
  tackle: THREE.AnimationClip | null;
  /** One-shot spin move. */
  spin: THREE.AnimationClip | null;
  /** One-shot tackle attempt (the defender making the hit). */
  defTackle: THREE.AnimationClip | null;
  /** One-shot ball-swat / pass-breakup attempt (defender). */
  defSwat: THREE.AnimationClip | null;
  /** One-shot touchdown / turnover celebration. */
  celebrate: THREE.AnimationClip | null;
  // --- sports-mocap one-shots (Mixamo) ---
  /** Real QB throwing motion (replaces the procedural arm-aim when present). */
  qbThrow: THREE.AnimationClip | null;
  /** Over-the-top heave for long / Hail-Mary throws (baseball pitch). */
  pitch: THREE.AnimationClip | null;
  /** Placekicker leg-swing (kickoffs / punts). */
  kick: THREE.AnimationClip | null;
  /** Alternate touchdown celebrations (golf swing / bat flip / tennis serve). */
  celebGolf: THREE.AnimationClip | null;
  celebBat: THREE.AnimationClip | null;
  celebTennis: THREE.AnimationClip | null;
  /** One-shot diving lunge (runner dive for the spot / defender dive-tackle). */
  dive: THREE.AnimationClip | null;
  /** One-shot loose-ball scoop (recovering a fumble). */
  pickup: THREE.AnimationClip | null;
  /** One-shot plant-and-turn-upfield (a hard direction reversal). */
  turnRun: THREE.AnimationClip | null;
}

export interface CharacterAsset {
  template: THREE.Group;
  clips: CharacterClips;
  /** Uniform scale to make the model ~1.95 world units tall. */
  scale: number;
  /** World-Y offset (pre-scale) that puts the model's feet on the ground. */
  groundOffset: number;
}

export interface CharacterUrls {
  /** Rigged model that also supplies the idle/stance animation. */
  model: string;
  run: string;
  runBack: string;
  strafe: string;
  pass: string;
  catch: string;
  juke: string;
  walk: string;
  tackle: string;
  spin: string;
  defTackle: string;
  defSwat: string;
  celebrate: string;
  // Optional clips (the main game supplies these; tools/sandboxes may omit them).
  backDiag?: string;
  qbThrow?: string;
  pitch?: string;
  kick?: string;
  celebGolf?: string;
  celebBat?: string;
  celebTennis?: string;
  dive?: string;
  pickup?: string;
  turnRun?: string;
}

/**
 * Prepare a clip: strip the root-motion (Hips translation) so it plays in place.
 * Bone-track names keep their (mixamorig) prefix so they bind to the rigged model.
 */
function prep(clip: THREE.AnimationClip): THREE.AnimationClip {
  const c = clip.clone();
  c.tracks = c.tracks.filter((t) => !/Hips\.position$/i.test(t.name));
  return c;
}

/**
 * Strict retarget for clips authored on a DIFFERENT-proportioned skeleton (the sports mocap): keep
 * ONLY rotation (quaternion) tracks and drop every position/scale track, so the clip drives our
 * rig's joint angles while the rig keeps its OWN bone lengths. Without this, the clips' baked bone
 * positions force our model into the source skeleton's proportions — the "tall + thin" stretch.
 */
function prepStrict(clip: THREE.AnimationClip): THREE.AnimationClip {
  const c = clip.clone();
  c.tracks = c.tracks.filter((t) => /\.quaternion$/i.test(t.name));
  return c;
}

/** Reject if a promise doesn't settle in time — a hung mobile fetch must not stall forever. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out: ${label}`)), ms)),
  ]);
}

/** Retry a flaky async load a few times with backoff (FBX fetches can blip on first paint). */
async function withRetry<T>(fn: () => Promise<T>, tries = 4, label = ""): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 250 * (i + 1)));
    }
  }
  throw new Error(`failed to load ${label} after ${tries} tries: ${String(lastErr)}`);
}

/**
 * Candidate URLs to try for an asset. The build uses relative paths (`base: "./"`), which 404 if
 * the page is served at a URL without a trailing slash — so fall back to root-absolute and
 * origin-absolute forms. This makes the model resolve no matter how the site is hosted.
 */
function pathCandidates(url: string): string[] {
  const name = url.split("/").pop() || url;
  const out = new Set<string>([url, `${name}`, `./${name}`, `/${name}`]);
  if (typeof location !== "undefined" && location.origin && location.origin !== "null") {
    out.add(`${location.origin}/${name}`);
    // …and relative to the current directory (handles a sub-path deploy served with a slash).
    out.add(new URL(name, location.href).toString());
  }
  return [...out];
}

/** Load an FBX, trying each path form (with retries) until one works. */
async function loadFbx(loader: FBXLoader, url: string): Promise<THREE.Group> {
  let lastErr: unknown;
  for (const candidate of pathCandidates(url)) {
    try {
      return await withRetry(() => withTimeout(loader.loadAsync(candidate), 20000, candidate), 3, candidate);
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`could not load ${url} (tried ${pathCandidates(url).length} paths): ${String(lastErr)}`);
}

/**
 * Free a loaded FBX scene's GPU/CPU resources. Each animation FBX ships a FULL character mesh we
 * don't keep (we only extract its AnimationClip), so on memory-constrained devices (Android Chrome)
 * those meshes MUST be released or 12 of them pile up and the later clip parses fail — which leaves
 * the player on idle-only and looking frozen. The AnimationClip is independent keyframe data, so
 * disposing the source meshes afterward is safe.
 */
function disposeSource(obj: THREE.Object3D): void {
  obj.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mat = mesh.material;
    const mats = Array.isArray(mat) ? mat : mat ? [mat] : [];
    for (const m of mats) {
      for (const v of Object.values(m as unknown as Record<string, unknown>)) {
        if (v && (v as THREE.Texture).isTexture) (v as THREE.Texture).dispose();
      }
      m.dispose();
    }
  });
}

/**
 * Load a single animation clip — BEST EFFORT. A failed clip resolves to `null` (that one
 * animation is simply disabled) so it can never take down the whole skinned model. Only the base
 * rig is critical. The source FBX mesh is disposed immediately (we keep only the clip).
 */
async function loadClip(loader: FBXLoader, url: string, strict = false): Promise<THREE.AnimationClip | null> {
  try {
    const fbx = await loadFbx(loader, url);
    const src = fbx.animations[0];
    const clip = src ? (strict ? prepStrict(src) : prep(src)) : null;
    disposeSource(fbx); // free the throwaway character mesh before the next clip loads
    return clip;
  } catch (e) {
    console.warn(`[character] animation clip failed (disabled, model still loads): ${url}`, e);
    return null;
  }
}

/** Build a CharacterAsset from a loaded rig + (possibly partial) clip set. */
function buildAsset(model: THREE.Group, clips: CharacterClips): CharacterAsset {
  const box = new THREE.Box3().setFromObject(model);
  const size = new THREE.Vector3();
  box.getSize(size);
  const height = size.y || 1;
  return { template: model, clips, scale: 1.95 / height, groundOffset: -box.min.y };
}

function emptyClips(idle: THREE.AnimationClip | null): CharacterClips {
  return { idle, run: null, runBack: null, strafe: null, backDiag: null, pass: null, catch: null, juke: null,
    walk: null, tackle: null, spin: null, defTackle: null, defSwat: null, celebrate: null,
    qbThrow: null, pitch: null, kick: null, celebGolf: null, celebBat: null, celebTennis: null,
    dive: null, pickup: null, turnRun: null };
}

/**
 * Load ONLY the rigged model (the critical asset) and return an asset with just its idle stance.
 * This lets the game swap box avatars for the skinned model the instant the (~1 MB) rig arrives,
 * instead of waiting on all ~13 MB of animation clips — so a slow/stalled clip fetch on mobile can
 * never leave the player staring at blocks.
 */
export async function loadBaseRig(modelUrl: string): Promise<CharacterAsset> {
  const loader = new FBXLoader();
  const model = await loadFbx(loader, modelUrl);
  const idle = model.animations[0] ? prep(model.animations[0]) : null;
  return buildAsset(model, emptyClips(idle));
}

/**
 * The clip slots that come from the separate animation FBXs (everything except `idle`), ordered so
 * the locomotion clips load FIRST — a moving player animates as soon as possible, and the heavier
 * one-shots stream in after.
 */
const CLIP_KEYS: Array<Exclude<keyof CharacterClips, "idle">> = [
  "run", "walk", "runBack", "strafe", "backDiag", "spin", "juke", "catch", "pass", "tackle", "defTackle", "defSwat", "celebrate",
  // Sports-mocap one-shots load last (lowest priority — locomotion + core one-shots come first).
  "qbThrow", "pitch", "kick", "celebGolf", "celebBat", "celebTennis", "dive", "pickup", "turnRun",
];
const CLIP_URL_KEY: Record<Exclude<keyof CharacterClips, "idle">, keyof CharacterUrls> = {
  run: "run", runBack: "runBack", strafe: "strafe", backDiag: "backDiag", pass: "pass", catch: "catch", juke: "juke",
  walk: "walk", tackle: "tackle", spin: "spin", defTackle: "defTackle", defSwat: "defSwat", celebrate: "celebrate",
  qbThrow: "qbThrow", pitch: "pitch", kick: "kick", celebGolf: "celebGolf", celebBat: "celebBat", celebTennis: "celebTennis",
  dive: "dive", pickup: "pickup", turnRun: "turnRun",
};
/** Clips authored on a different skeleton — retarget rotation-only to preserve our proportions. */
const SPORTS_RETARGET = new Set<Exclude<keyof CharacterClips, "idle">>(["qbThrow", "pitch", "kick", "celebGolf", "celebBat", "celebTennis", "dive", "pickup", "backDiag", "turnRun"]);

/** True once every animation clip (not just idle) is loaded — i.e. nothing left to retry. */
export function clipsComplete(asset: CharacterAsset): boolean {
  return CLIP_KEYS.every((k) => asset.clips[k] != null);
}

/** How many of the animation clips are loaded (for spotting when a retry actually added one). */
export function loadedClipCount(asset: CharacterAsset): number {
  return CLIP_KEYS.reduce((n, k) => n + (asset.clips[k] != null ? 1 : 0), 0);
}

/** True once the locomotion clips are in — enough to apply so moving players animate immediately. */
export function locomotionReady(asset: CharacterAsset): boolean {
  const c = asset.clips;
  return c.run != null && c.walk != null && c.runBack != null && c.strafe != null;
}

/**
 * Load the animation clips MISSING from `current` (best-effort per clip) and merge them in. Clips
 * already present are NOT re-fetched, so this is safe to call repeatedly to fill gaps — the key to
 * bulletproof animations: a clip that blipped on a flaky connection gets retried on the next call
 * (driven by Game.ts) instead of being silently disabled forever. Returns a NEW merged asset.
 */
export async function loadAnimationClips(
  current: CharacterAsset,
  urls: CharacterUrls,
  onProgress?: (partial: CharacterAsset) => void,
): Promise<CharacterAsset> {
  const loader = new FBXLoader();
  const clips: CharacterClips = { ...current.clips };
  // Load SEQUENTIALLY (not Promise.all): each animation FBX carries a full character mesh, so
  // fetching all 12 at once spikes memory and the parses fail on phones — exactly the "models load
  // but never animate" symptom. One at a time keeps peak memory at a single FBX. `onProgress` lets
  // the caller apply the locomotion clips the moment they arrive instead of waiting for all 12.
  for (const k of CLIP_KEYS) {
    if (clips[k] != null) continue;
    const url = urls[CLIP_URL_KEY[k]];
    if (!url) continue; // optional clip not supplied (e.g. a sandbox) — skip it
    // The sports mocap is on a differently-proportioned skeleton: retarget rotation-only so it
    // doesn't stretch our model. The game's own clips keep the normal prep.
    clips[k] = await loadClip(loader, url, SPORTS_RETARGET.has(k));
    onProgress?.(buildAsset(current.template, { ...clips }));
  }
  return buildAsset(current.template, clips);
}

/**
 * Full character load: rig + all clips. The rig is critical (retried + timed out + path-fallback);
 * every clip is best-effort and never rejects, so a single flaky fetch can't drop to box avatars.
 * (Game.ts loads in two stages — rig first, then clips — so the model appears immediately.)
 */
export async function loadCharacter(urls: CharacterUrls): Promise<CharacterAsset> {
  const rig = await loadBaseRig(urls.model);
  return loadAnimationClips(rig, urls);
}
