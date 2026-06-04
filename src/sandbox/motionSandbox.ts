import * as THREE from "three";
import { PhysicsWorld } from "../physics/PhysicsWorld";
import { Ragdoll, type BoneTransform } from "../physics/Ragdoll";
import { LocomotionController } from "../physics/LocomotionController";
import { createMotionDebugPanel } from "../debug/MotionDebugPanel";

/**
 * Standalone development scene for the physics motion engine (Slice 1). Renders one
 * active ragdoll as simple capsule/box meshes driven directly by the physics bodies,
 * with the live debug panel. No game logic — this is the tuning harness.
 */
async function main(): Promise<void> {
  // --- renderer / scene ---
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
  renderer.shadowMap.enabled = true;
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x10141a);

  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(2.4, 1.5, 3.4);
  camera.lookAt(0, 1.0, 0);

  scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x202428, 1.0));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(4, 8, 5);
  sun.castShadow = true;
  scene.add(sun);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(40, 40),
    new THREE.MeshStandardMaterial({ color: 0x2b6b3a, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  const grid = new THREE.GridHelper(40, 40, 0x335544, 0x223322);
  scene.add(grid);

  // --- physics + ragdoll + locomotion ---
  const physics = await PhysicsWorld.create();
  const ragdoll = new Ragdoll(physics);
  const loco = new LocomotionController(ragdoll, physics);
  loco.activate(); // Slice 2 default: stand & balance on its own feet (chest unpinned)
  createMotionDebugPanel(ragdoll, physics, loco);
  // Dev handle (sandbox page only) for scripted testing.
  (window as unknown as { __motion: unknown }).__motion = { ragdoll, physics, loco, camera, scene, THREE };

  // One mesh per bone, matching the collider shape.
  const mat = new THREE.MeshStandardMaterial({ color: 0xd23a3a, roughness: 0.6 });
  const headMat = new THREE.MeshStandardMaterial({ color: 0xe8c9a0, roughness: 0.7 });
  const meshes: THREE.Mesh[] = [];
  for (const b of ragdoll.spec.bones) {
    let geo: THREE.BufferGeometry;
    if (b.shape.kind === "capsule") geo = new THREE.CapsuleGeometry(b.shape.radius, b.shape.halfHeight * 2, 6, 12);
    else if (b.shape.kind === "ball") geo = new THREE.SphereGeometry(b.shape.radius, 16, 12);
    else geo = new THREE.BoxGeometry(b.shape.hx * 2, b.shape.hy * 2, b.shape.hz * 2);
    const m = new THREE.Mesh(geo, b.name === "head" ? headMat : mat);
    m.castShadow = true;
    scene.add(m);
    meshes.push(m);
  }

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // --- fixed-step loop ---
  const STEP = 1 / 60;
  let last = performance.now();
  let acc = 0;
  const xforms: BoneTransform[] = [];

  function frame(now: number): void {
    requestAnimationFrame(frame);
    acc += Math.min(0.25, (now - last) / 1000);
    last = now;
    let steps = 0;
    while (acc >= STEP) {
      loco.tick(STEP); // gait FSM + leg targets + foot-locks (once per physics frame)
      physics.step((dt) => {
        loco.applyAssist(dt); // balance wrench, re-applied per substep
        ragdoll.update(dt); // PD muscle re-applied per substep
      });
      acc -= STEP;
      if (++steps >= 5) { acc = 0; break; }
    }
    ragdoll.getBoneTransforms(xforms);
    for (let i = 0; i < meshes.length; i++) {
      meshes[i].position.copy(xforms[i].position);
      meshes[i].quaternion.copy(xforms[i].quaternion);
    }
    renderer.render(scene, camera);
  }
  requestAnimationFrame(frame);
}

main().catch((e) => {
  console.error("motion sandbox failed:", e);
  document.body.innerHTML = `<pre style="color:#f88;padding:20px">Motion sandbox error:\n${e?.stack || e}</pre>`;
});
