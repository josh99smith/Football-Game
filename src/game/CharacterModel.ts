import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";

export interface CharacterAsset {
  template: THREE.Group;
  clip: THREE.AnimationClip | null;
  /** Uniform scale to make the model ~1.95 world units tall. */
  scale: number;
  /** World-Y offset (pre-scale) that puts the model's feet on the ground. */
  groundOffset: number;
}

/**
 * Loads the skinned FBX character once. The result is a template that is cloned
 * (with its skeleton) for each on-field player, plus the run/idle animation clip.
 */
export async function loadCharacter(url: string): Promise<CharacterAsset> {
  const loader = new FBXLoader();
  const fbx = await loader.loadAsync(url);

  const box = new THREE.Box3().setFromObject(fbx);
  const size = new THREE.Vector3();
  box.getSize(size);
  const height = size.y || 1;

  return {
    template: fbx,
    clip: fbx.animations[0] ?? null,
    scale: 1.95 / height,
    groundOffset: -box.min.y,
  };
}
