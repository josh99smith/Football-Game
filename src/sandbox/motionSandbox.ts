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

  // --- live debug HUD (top-left): updates every frame so numbers move with the sliders ---
  const hud = document.createElement("div");
  hud.style.cssText =
    "position:fixed;top:8px;left:8px;z-index:10;font:12px/1.5 ui-monospace,Menlo,monospace;" +
    "color:#cfe;background:rgba(10,14,20,.72);padding:8px 10px;border-radius:6px;" +
    "white-space:pre;pointer-events:none;min-width:182px;text-shadow:0 1px 2px #000";
  document.body.appendChild(hud);
  let hudT = 0;
  const fmt = (n: number, d = 2) => n.toFixed(d).padStart(6);
  function updateHud(): void {
    const h = loco.hud();
    const slip = h.legs.map((l) => `${l.side}:${l.planted ? `${l.slipMm.toFixed(0).padStart(2)}mm` : "swing"}`).join("  ");
    const tipFlag = h.tip > 0.12 ? "  ⚠tipping" : "";
    hud.textContent =
      `mode      ${h.mode}\n` +
      `speed     ${fmt(h.speed)} / ${fmt(h.targetSpeed)} m/s\n` +
      `pelvis Y  ${fmt(h.pelvisY)} m\n` +
      `com Y     ${fmt(h.comY)} m\n` +
      `tip (side) ${fmt(h.tip)} m${tipFlag}\n` +
      `assist    ${fmt(h.assist)}\n` +
      `ik err    ${(h.ikErr * 1000).toFixed(0).padStart(4)} mm\n` +
      `feet      ${slip}`;
  }

  // --- fixed-step loop ---
  const STEP = 1 / 60;
  let last = performance.now();
  let acc = 0;
  const xforms: BoneTransform[] = [];
  const _com = new THREE.Vector3();
  const camFocus = new THREE.Vector3(0, 1.0, 0);
  let sideView = false;
  window.addEventListener("keydown", (e) => { if (e.key === "v" || e.key === "V") sideView = !sideView; });
  (window as unknown as { __motion: { sideView?: boolean } }).__motion.sideView = false;
  Object.defineProperty((window as unknown as { __motion: Record<string, unknown> }).__motion, "setSideView", {
    value: (v: boolean) => { sideView = v; },
  });

  // One fixed simulation step (the single source of truth for advancing physics).
  function simStep(): void {
    loco.tick(STEP); // gait + leg targets + foot-locks (once per physics frame)
    physics.step(STEP, (dt) => {
      loco.applyAssist(dt); // balance wrench, re-applied per substep
      ragdoll.update(dt); // PD muscle re-applied per substep
    });
  }
  // Deterministic stepping for faithful capture/eval: advance exactly N fixed steps
  // regardless of wall-clock (real-time RAF feeds variable dt that destabilises physics
  // during slow screenshot loops — that is a capture artifact, not the gait).
  let paused = false;
  const mo = (window as unknown as { __motion: Record<string, unknown> }).__motion;
  mo.setPaused = (v: boolean) => { paused = v; };
  mo.stepFixed = (n: number) => { for (let i = 0; i < (n || 1); i++) simStep(); renderFrame(); };

  function frame(now: number): void {
    requestAnimationFrame(frame);
    acc += Math.min(0.25, (now - last) / 1000);
    last = now;
    if (paused) { acc = 0; renderFrame(); return; }
    let steps = 0;
    while (acc >= STEP) {
      simStep();
      acc -= STEP;
      if (++steps >= 5) { acc = 0; break; }
    }
    renderFrame();
  }

  function renderFrame(): void {
    ragdoll.getBoneTransforms(xforms);
    for (let i = 0; i < meshes.length; i++) {
      meshes[i].position.copy(xforms[i].position);
      meshes[i].quaternion.copy(xforms[i].quaternion);
    }
    // Follow camera so a walking figure stays framed (smoothed toward the COM). Two views:
    // 3/4 (default) and a true side profile at body height (press "V") — the side view shows
    // real trunk pitch and stride without the foreshortening of a high 3/4 angle.
    const com = ragdoll.getCOM(_com);
    camFocus.lerp(_com.set(com.x, 1.0, com.z), 0.12);
    if (sideView) {
      camera.position.set(camFocus.x + 4.2, 0.95, camFocus.z);
      camera.lookAt(camFocus.x, 0.85, camFocus.z);
    } else {
      camera.position.set(camFocus.x + 2.6, 1.6, camFocus.z + 3.2);
      camera.lookAt(camFocus);
    }

    hudT += STEP;
    if (hudT >= 0.1) { hudT = 0; updateHud(); } // refresh HUD ~10x/s
    renderer.render(scene, camera);
  }
  requestAnimationFrame(frame);
}

main().catch((e) => {
  console.error("motion sandbox failed:", e);
  document.body.innerHTML = `<pre style="color:#f88;padding:20px">Motion sandbox error:\n${e?.stack || e}</pre>`;
});
