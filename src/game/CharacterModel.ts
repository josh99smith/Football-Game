import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";

export interface CharacterAsset {
  template: THREE.Group;
  /** Idle clip (from the character file). */
  clip: THREE.AnimationClip | null;
  /** Forward jog clip, root-motion removed, for running. */
  runClip: THREE.AnimationClip | null;
  /** Uniform scale to make the model ~1.95 world units tall. */
  scale: number;
  /** World-Y offset (pre-scale) that puts the model's feet on the ground. */
  groundOffset: number;
}

/** Strip any `mixamorig:` prefix so clip tracks bind to our (unprefixed) bones. */
function normalizeTrackNames(clip: THREE.AnimationClip): void {
  for (const t of clip.tracks) t.name = t.name.replace(/mixamorig[:_]?/i, "");
}

/**
 * Loads the skinned FBX character plus a forward-jog animation clip. The jog's root
 * motion (Hips translation) is stripped so the character runs "in place" while the
 * game drives its position.
 */
export async function loadCharacter(charUrl: string, runUrl: string): Promise<CharacterAsset> {
  const loader = new FBXLoader();
  const [fbx, runFbx] = await Promise.all([loader.loadAsync(charUrl), loader.loadAsync(runUrl)]);

  const clip = fbx.animations[0] ?? null;
  if (clip) normalizeTrackNames(clip);

  let runClip = runFbx.animations[0] ?? null;
  if (runClip) {
    normalizeTrackNames(runClip);
    // Drop root-motion translation so the jog stays in place.
    runClip = runClip.clone();
    runClip.tracks = runClip.tracks.filter((t) => t.name !== "Hips.position");
  }

  const box = new THREE.Box3().setFromObject(fbx);
  const size = new THREE.Vector3();
  box.getSize(size);
  const height = size.y || 1;

  return {
    template: fbx,
    clip,
    runClip,
    scale: 1.95 / height,
    groundOffset: -box.min.y,
  };
}
