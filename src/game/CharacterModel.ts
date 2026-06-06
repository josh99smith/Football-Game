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
 * Load a single animation clip — BEST EFFORT. A failed clip resolves to `null` (that one
 * animation is simply disabled) so it can never take down the whole skinned model. Only the base
 * rig is critical.
 */
async function loadClip(loader: FBXLoader, url: string): Promise<THREE.AnimationClip | null> {
  try {
    const fbx = await loadFbx(loader, url);
    return fbx.animations[0] ? prep(fbx.animations[0]) : null;
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
  return { idle, run: null, runBack: null, strafe: null, pass: null, catch: null, juke: null,
    walk: null, tackle: null, spin: null, defTackle: null, defSwat: null, celebrate: null };
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

/** Load all animation clips (best-effort; each resolves null on failure) onto an existing rig. */
export async function loadAnimationClips(rig: CharacterAsset, urls: CharacterUrls): Promise<CharacterAsset> {
  const loader = new FBXLoader();
  const [run, runBack, strafe, pass, catchClip, juke, walk, tackle, spin, defTackle, defSwat, celebrate] =
    await Promise.all([
      loadClip(loader, urls.run),
      loadClip(loader, urls.runBack),
      loadClip(loader, urls.strafe),
      loadClip(loader, urls.pass),
      loadClip(loader, urls.catch),
      loadClip(loader, urls.juke),
      loadClip(loader, urls.walk),
      loadClip(loader, urls.tackle),
      loadClip(loader, urls.spin),
      loadClip(loader, urls.defTackle),
      loadClip(loader, urls.defSwat),
      loadClip(loader, urls.celebrate),
    ]);
  return buildAsset(rig.template, {
    idle: rig.clips.idle, run, runBack, strafe, pass, catch: catchClip, juke, walk, tackle, spin, defTackle, defSwat, celebrate,
  });
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
