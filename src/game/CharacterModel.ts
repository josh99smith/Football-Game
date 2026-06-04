import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";

export interface CharacterClips {
  /** Offense ready stance / default idle. */
  idle: THREE.AnimationClip | null;
  /** Defensive ready stance. */
  defender: THREE.AnimationClip | null;
  /** Forward jog (locomotion). */
  run: THREE.AnimationClip | null;
  /** One-shot QB throw. */
  pass: THREE.AnimationClip | null;
  /** One-shot reception. */
  catch: THREE.AnimationClip | null;
}

export interface CharacterAsset {
  template: THREE.Group;
  clips: CharacterClips;
  /** Uniform scale to make the model ~1.95 world units tall. */
  scale: number;
  /** World-Y offset (pre-scale) that puts the model's feet on the ground. */
  groundOffset: number;
}

export interface AnimUrls {
  run: string;
  pass: string;
  catch: string;
  stance: string;
  defender: string;
}

/** Strip any `mixamorig:` prefix so clip tracks bind to our (unprefixed) bones. */
function normalize(clip: THREE.AnimationClip): THREE.AnimationClip {
  const c = clip.clone();
  for (const t of c.tracks) t.name = t.name.replace(/mixamorig[:_]?/i, "");
  // Drop root-motion translation so the clip plays in place.
  c.tracks = c.tracks.filter((t) => t.name !== "Hips.position");
  return c;
}

async function loadClip(loader: FBXLoader, url: string): Promise<THREE.AnimationClip | null> {
  const fbx = await loader.loadAsync(url);
  return fbx.animations[0] ? normalize(fbx.animations[0]) : null;
}

/**
 * Loads the skinned character plus a set of Mixamo-compatible animation clips
 * (stance/idle, defender stance, jog, pass, catch). Root motion is stripped so
 * everything plays in place while the game drives position.
 */
export async function loadCharacter(charUrl: string, urls: AnimUrls): Promise<CharacterAsset> {
  const loader = new FBXLoader();
  const [fbx, run, pass, catchClip, stance, defender] = await Promise.all([
    loader.loadAsync(charUrl),
    loadClip(loader, urls.run),
    loadClip(loader, urls.pass),
    loadClip(loader, urls.catch),
    loadClip(loader, urls.stance),
    loadClip(loader, urls.defender),
  ]);

  const fallbackIdle = fbx.animations[0] ? normalize(fbx.animations[0]) : null;

  const box = new THREE.Box3().setFromObject(fbx);
  const size = new THREE.Vector3();
  box.getSize(size);
  const height = size.y || 1;

  return {
    template: fbx,
    clips: { idle: stance ?? fallbackIdle, defender: defender ?? stance ?? fallbackIdle, run, pass, catch: catchClip },
    scale: 1.95 / height,
    groundOffset: -box.min.y,
  };
}
