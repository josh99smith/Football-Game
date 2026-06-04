import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";

export interface CharacterClips {
  /** Offense ready stance / default idle. */
  idle: THREE.AnimationClip | null;
  /** Defensive ready stance. */
  defender: THREE.AnimationClip | null;
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
  defender: string;
  juke: string;
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

async function loadClip(loader: FBXLoader, url: string): Promise<THREE.AnimationClip | null> {
  const fbx = await loader.loadAsync(url);
  return fbx.animations[0] ? prep(fbx.animations[0]) : null;
}

/**
 * Loads the rigged player model (whose own clip is the idle stance) plus the jog,
 * pass, catch, and defender animation clips. All clips bind to the model's skeleton
 * by bone name; root motion is stripped so everything plays in place.
 */
export async function loadCharacter(urls: CharacterUrls): Promise<CharacterAsset> {
  const loader = new FBXLoader();
  const [model, run, runBack, strafe, pass, catchClip, defender, juke] = await Promise.all([
    loader.loadAsync(urls.model),
    loadClip(loader, urls.run),
    loadClip(loader, urls.runBack),
    loadClip(loader, urls.strafe),
    loadClip(loader, urls.pass),
    loadClip(loader, urls.catch),
    loadClip(loader, urls.defender),
    loadClip(loader, urls.juke),
  ]);

  const idle = model.animations[0] ? prep(model.animations[0]) : null;

  const box = new THREE.Box3().setFromObject(model);
  const size = new THREE.Vector3();
  box.getSize(size);
  const height = size.y || 1;

  return {
    template: model,
    clips: { idle, defender: defender ?? idle, run, runBack, strafe, pass, catch: catchClip, juke },
    scale: 1.95 / height,
    groundOffset: -box.min.y,
  };
}
