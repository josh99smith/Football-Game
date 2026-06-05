import * as THREE from "three";
import { loadCharacter, type CharacterAsset } from "../game/CharacterModel";
import { PhysicsWorld } from "../physics/PhysicsWorld";
import { TackleRagdoll } from "../physics/TackleRagdoll";

/**
 * Hybrid sandbox — the animation+physics combination, built and tuned in isolation before
 * it goes into the game.
 *
 * Slice 1 (this file, for now): load the real rigged Mixamo character and play its
 * locomotion clips (idle / walk / run) animation-driven. It also dumps the skeleton (bone
 * names + rest lengths) to `window.__hybrid.skeleton` — that's the basis for building a
 * Rapier ragdoll whose proportions MATCH this rig, which the next slice blends to on impact.
 */

const base = import.meta.env.BASE_URL;
const URLS = {
  model: `${base}rig_stance.fbx`,
  run: `${base}standard_run.fbx`,
  runBack: `${base}run_backward.fbx`,
  strafe: `${base}strafe.fbx`,
  pass: `${base}rig_pass.fbx`,
  catch: `${base}rig_catch.fbx`,
  juke: `${base}change_dir.fbx`,
  walk: `${base}walk.fbx`,
  tackle: `${base}tackle.fbx`,
  spin: `${base}spin.fbx`,
  defTackle: `${base}def_tackle.fbx`,
  defSwat: `${base}def_swat.fbx`,
  celebrate: `${base}celebrate.fbx`,
};

/** Walk the model and list every bone with its name and parent — the rig we must match. */
function dumpSkeleton(root: THREE.Object3D): { name: string; parent: string; len: number }[] {
  const out: { name: string; parent: string; len: number }[] = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  root.updateWorldMatrix(true, true);
  root.traverse((o) => {
    if (!(o as THREE.Bone).isBone) return;
    o.getWorldPosition(a);
    o.parent?.getWorldPosition(b);
    out.push({
      name: o.name,
      parent: o.parent?.name ?? "",
      len: o.parent ? +a.distanceTo(b).toFixed(3) : 0,
    });
  });
  return out;
}

async function main(): Promise<void> {
  const msg = document.getElementById("msg") as HTMLDivElement;

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
  renderer.shadowMap.enabled = true;
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x10141a);

  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(2.6, 1.6, 3.4);
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
  scene.add(new THREE.GridHelper(40, 40, 0x335544, 0x223322));

  let asset: CharacterAsset;
  try {
    asset = await loadCharacter(URLS);
  } catch (e) {
    msg.textContent = `character load failed:\n${(e as Error)?.message ?? e}`;
    throw e;
  }

  // Place the rigged model, feet on the ground, animation-driven.
  const model = asset.template;
  model.scale.setScalar(asset.scale);
  model.position.y = asset.groundOffset * asset.scale;
  model.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) { m.castShadow = true; m.frustumCulled = false; } // bones leave the box when ragdolled
  });
  scene.add(model);

  // Physics ragdoll for tackles (built to match this rig's skeleton).
  const physics = await PhysicsWorld.create();
  const ragdoll = new TackleRagdoll(physics);
  ragdoll.bind(model);

  // Snapshot the rig's rest pose so a reset is clean: the idle/walk clips have their Hips
  // POSITION track stripped (root motion), so nothing animates the body back from where it
  // fell — we must restore it ourselves.
  const restPose = new Map<THREE.Bone, { p: THREE.Vector3; q: THREE.Quaternion }>();
  model.traverse((o) => {
    if ((o as THREE.Bone).isBone) restPose.set(o as THREE.Bone, { p: o.position.clone(), q: o.quaternion.clone() });
  });

  const mixer = new THREE.AnimationMixer(model);
  const c = asset.clips;
  const actions = {
    idle: c.idle ? mixer.clipAction(c.idle) : null,
    walk: c.walk ? mixer.clipAction(c.walk) : null,
    run: c.run ? mixer.clipAction(c.run) : null,
  };
  for (const a of Object.values(actions)) { a?.setLoop(THREE.LoopRepeat, Infinity); a?.play(); a?.setEffectiveWeight(0); }

  // Speed 0..1 crossfades idle -> walk -> run.
  let speed = 0.5;
  function applyLocomotion(): void {
    const idleW = Math.max(0, 1 - speed * 2);
    const walkW = Math.max(0, 1 - Math.abs(speed - 0.5) * 2);
    const runW = Math.max(0, speed * 2 - 1);
    actions.idle?.setEffectiveWeight(idleW);
    actions.walk?.setEffectiveWeight(walkW);
    actions.run?.setEffectiveWeight(runW);
  }
  applyLocomotion();

  const skeleton = dumpSkeleton(model);

  // --- tackle lifecycle: animation -> fall (physics) -> settle -> get up -> animation ---
  type Phase = "anim" | "fall" | "getup";
  let phase: Phase = "anim";
  let fallTime = 0;    // seconds since the hit landed
  let settleTimer = 0; // seconds the body has been calm (resets if it gets bumped)
  let getupT = 0;      // get-up blend progress 0..1
  const SETTLE_RESIDUAL = 0.8; // total body speed below which it counts as "calm" (settled ~0.35)
  const MIN_FALL = 0.5;        // don't check for calm until the fall is underway
  const CALM_NEEDED = 0.7;     // stay calm this long (incl. a beat lying there) before standing
  const MAX_FALL = 6;          // safety: stand up even if it never fully settles
  const GETUP_DUR = 1.1;       // seconds to rise to standing
  // Lying pose captured at the moment we start standing, blended back toward the rest pose.
  const getupFrom = new Map<THREE.Bone, { p: THREE.Vector3; q: THREE.Quaternion }>();

  // The hit: a direction + speed (m/s) on one tier of the body. The runner's own momentum
  // (from the current locomotion speed, forward +Z) is carried into the fall, so a sprinting
  // player tumbles much farther than a walking one. `hitLow` cuts the legs out (forward flip).
  function triggerTackle(dir = [0, 0, 1], speed_ = 3.5, hitLow = false): void {
    if (phase !== "anim") return;
    model.updateWorldMatrix(true, true); // freeze the live animated pose
    const d = new THREE.Vector3(...dir);
    if (d.lengthSq() < 1e-6) d.set(0, 0, 1);
    d.normalize();
    const carry = new THREE.Vector3(0, 0, speed * 5.5); // running momentum (idle 0 .. run ~5.5 m/s)
    ragdoll.spawn(carry, d, speed_, hitLow);
    phase = "fall"; fallTime = 0; settleTimer = 0; // mixer paused; bodies now drive the bones
  }

  // Limbs gather before the torso rises and the arms swing in last, so the blend reads as
  // pushing up off the ground rather than the whole body floating up at once.
  function getupDelay(name: string): number {
    if (/UpLeg|Leg|Foot|Toe|Hips/.test(name)) return 0;      // legs/hips lead
    if (/Spine|Neck|Head/.test(name)) return 0.18;           // spine/head follow
    return 0.3;                                               // arms/hands last
  }
  const _gp = new THREE.Vector3();
  function startGetup(): void {
    getupFrom.clear();
    for (const [bone] of restPose) getupFrom.set(bone, { p: bone.position.clone(), q: bone.quaternion.clone() });
    ragdoll.dispose(); // hand off from physics to the procedural blend
    phase = "getup"; getupT = 0;
  }
  function blendGetup(t: number): void {
    for (const [bone, from] of getupFrom) {
      const to = restPose.get(bone)!;
      const d = getupDelay(bone.name);
      const e = ease(Math.min(1, Math.max(0, (t - d) / (1 - d))));
      bone.quaternion.copy(from.q).slerp(to.q, e);
      if (bone.name.endsWith("Hips")) {
        // Stand up where the body settled: keep the fallen X/Z, raise Y to standing height.
        _gp.set(from.p.x, THREE.MathUtils.lerp(from.p.y, to.p.y, ease(t)), from.p.z);
        bone.position.copy(_gp);
      } else {
        bone.position.lerpVectors(from.p, to.p, e); // limbs return to their rest offsets
      }
    }
    model.updateWorldMatrix(true, true);
  }
  function finishGetup(): void {
    phase = "anim";
    setSpeed01(0); // up and standing -> idle
  }
  function ease(x: number): number { return x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2; }

  function reset(): void {
    if (phase !== "anim") { if (ragdoll.active) ragdoll.dispose(); phase = "anim"; }
    // Restore the rest pose (incl. Hips position the clips don't touch), then resume animation.
    for (const [bone, r] of restPose) { bone.position.copy(r.p); bone.quaternion.copy(r.q); }
    model.updateWorldMatrix(true, true);
    setSpeed01(0.5);
  }

  // One simulation tick, shared by the live loop and the deterministic headless stepper.
  let shownPhase: Phase | null = null;
  function update(dt: number): void {
    if (phase !== shownPhase) { shownPhase = phase; setMsg(); } // auto get-up changes phase itself
    if (phase === "fall") {
      physics.step((sdt) => ragdoll.applyLimits(sdt)); // soft joint limits each substep
      ragdoll.drive();                                  // bodies drive the skinned mesh bones
      fallTime += dt;
      if (fallTime > MIN_FALL && ragdoll.residualMotion() < SETTLE_RESIDUAL) settleTimer += dt;
      else settleTimer = 0;
      if (settleTimer > CALM_NEEDED || fallTime > MAX_FALL) startGetup();
    } else if (phase === "getup") {
      getupT += dt / GETUP_DUR;
      blendGetup(Math.min(1, getupT));
      if (getupT >= 1) finishGetup();
    } else {
      mixer.update(dt); // animation-driven
    }
  }

  function setMsg(): void {
    msg.textContent =
      `character — ${skeleton.length} bones, ${Object.entries(c).filter(([, v]) => v).length} clips\n` +
      `[1/2/3] idle/walk/run   [T] tackle   [R] reset\n` +
      `state: ${phase === "fall" ? "RAGDOLL (physics)" : phase === "getup" ? "getting up…" : "animation"}`;
  }
  setMsg();
  window.addEventListener("keydown", (e) => {
    if (e.key === "1") { speed = 0; applyLocomotion(); }
    if (e.key === "2") { speed = 0.5; applyLocomotion(); }
    if (e.key === "3") { speed = 1; applyLocomotion(); }
    if (e.key === "t" || e.key === "T") tackleRandom();
    if (e.key === "r" || e.key === "R") reset();
    setMsg();
  });

  // A tackle from a random direction + varied force so every tap lands differently:
  // sometimes a gentle stumble, sometimes a big hit; ~1 in 3 is a low hit (legs cut out).
  function tackleRandom(): void {
    const ang = Math.random() * Math.PI * 2; // random horizontal hit direction
    const speed_ = 2.5 + Math.random() * 4; // 2.5 (stumble) .. 6.5 (big hit) m/s
    const hitLow = Math.random() < 0.35;
    const lift = hitLow ? 0.05 : 0.18; // low hits stay low; high hits lift a bit
    triggerTackle([Math.cos(ang), lift, Math.sin(ang)], speed_, hitLow);
  }

  // --- on-screen touch controls (the demo runs on a phone) ---
  const bar = document.createElement("div");
  bar.style.cssText =
    "position:fixed;left:0;right:0;bottom:0;z-index:20;display:flex;gap:6px;justify-content:center;" +
    "align-items:center;flex-wrap:wrap;padding:8px;padding-bottom:max(8px,env(safe-area-inset-bottom));" +
    "pointer-events:none;font:600 15px system-ui,-apple-system,sans-serif;";
  document.body.appendChild(bar);
  function mkBtn(label: string, opts: { big?: boolean; bg?: string }, handler: () => void): HTMLButtonElement {
    const el = document.createElement("button");
    el.textContent = label;
    el.style.cssText =
      "pointer-events:auto;border:none;border-radius:13px;color:#fff;font:inherit;" +
      `padding:${opts.big ? "16px 22px" : "11px 13px"};font-size:${opts.big ? "17px" : "13px"};` +
      `background:${opts.bg ?? "rgba(40,48,60,.82)"};box-shadow:0 2px 10px rgba(0,0,0,.45);` +
      "touch-action:manipulation;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;white-space:nowrap;";
    el.addEventListener("click", (e) => { e.preventDefault(); handler(); setMsg(); });
    bar.appendChild(el);
    return el;
  }
  const speedDefs: [string, number][] = [["Idle", 0], ["Walk", 0.5], ["Run", 1]];
  const speedBtns: HTMLButtonElement[] = [];
  function setSpeed01(s: number): void {
    speed = s; applyLocomotion();
    speedBtns.forEach((b, i) => { b.style.outline = speedDefs[i][1] === s ? "2px solid #6cf" : "none"; });
  }
  for (const [label, s] of speedDefs) speedBtns.push(mkBtn(label, {}, () => setSpeed01(s)));
  const spacer = document.createElement("div"); spacer.style.width = "10px"; bar.appendChild(spacer);
  mkBtn("TACKLE", { big: true, bg: "rgba(214,58,58,.92)" }, tackleRandom);
  mkBtn("Reset", { bg: "rgba(60,120,80,.85)" }, reset);
  setSpeed01(0.5);

  // Dev handle for scripted/headless testing.
  (window as unknown as { __hybrid: unknown }).__hybrid = {
    THREE, scene, camera, model, mixer, actions, physics, ragdoll,
    setSpeed: (s: number) => { speed = s; applyLocomotion(); },
    triggerTackle, reset, isRagdolled: () => phase !== "anim", getPhase: () => phase,
    skeleton,
  };

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // Follow camera so the falling body stays framed.
  const hips = ragdoll.getBone("Hips");
  const camFocus = new THREE.Vector3(0, 1.0, 0);
  const _fp = new THREE.Vector3();
  function updateCamera(): void {
    if (hips) hips.getWorldPosition(_fp); else _fp.set(0, 1, 0);
    _fp.y = Math.max(0.4, _fp.y);
    camFocus.lerp(_fp, 0.12);
    camera.position.set(camFocus.x + 2.8, camFocus.y + 1.2, camFocus.z + 3.6);
    camera.lookAt(camFocus);
  }

  const clock = new THREE.Clock();
  let externalDrive = false; // headless stepFixed takes over; the rAF loop must not also step
  function frame(): void {
    requestAnimationFrame(frame);
    if (externalDrive) return;
    update(Math.min(0.05, clock.getDelta())); // clamp dt so a stalled tab can't blow up physics
    updateCamera();
    renderer.render(scene, camera);
  }
  requestAnimationFrame(frame);

  // Deterministic stepping for faithful headless capture (real-time dt destabilises physics
  // during slow screenshot loops — same lesson as the motion sandbox).
  (window as unknown as { __hybrid: { stepFixed?: (n: number) => void } }).__hybrid.stepFixed = (n: number) => {
    externalDrive = true; // stop the rAF loop double-stepping the sim
    for (let i = 0; i < (n || 1); i++) update(1 / 60);
    updateCamera();
    renderer.render(scene, camera);
  };
}

main().catch((e) => {
  console.error("hybrid sandbox failed:", e);
  const msg = document.getElementById("msg");
  if (msg) msg.textContent = `hybrid sandbox error:\n${(e as Error)?.stack || e}`;
});
