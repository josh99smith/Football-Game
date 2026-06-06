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
      return await withRetry(() => loader.loadAsync(candidate), 3, candidate);
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

/**
 * Loads the rigged player model (whose own clip is the idle stance) plus the jog,
 * pass, catch, and defender animation clips. All clips bind to the model's skeleton
 * by bone name; root motion is stripped so everything plays in place.
 *
 * Resilience: the base rig is the ONLY critical asset (it's retried hard); every animation clip
 * is loaded best-effort and never rejects, so a single flaky fetch can't drop the whole game back
 * to box avatars. The skinned model shows as long as the rig itself can be fetched.
 */
export async function loadCharacter(urls: CharacterUrls): Promise<CharacterAsset> {
  const loader = new FBXLoader();
  // The rigged model is critical — try every path form, retry hard. (Clips are best-effort.)
  const model = await loadFbx(loader, urls.model);
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

  const idle = model.animations[0] ? prep(model.animations[0]) : null;

  const box = new THREE.Box3().setFromObject(model);
  const size = new THREE.Vector3();
  box.getSize(size);
  const height = size.y || 1;

  return {
    template: model,
    clips: { idle, run, runBack, strafe, pass, catch: catchClip, juke, walk, tackle, spin, defTackle, defSwat, celebrate },
    scale: 1.95 / height,
    groundOffset: -box.min.y,
  };
}
