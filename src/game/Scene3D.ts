import * as THREE from "three";
import { clone as skeletonClone } from "three/examples/jsm/utils/SkeletonUtils.js";
import type { Player } from "./entities/Player";
import type { Ball } from "./entities/Ball";
import type { CharacterAsset } from "./CharacterModel";
import { Field, FIELD_LENGTH, FIELD_WIDTH, PX_PER_YARD, ENDZONE_PX } from "./Field";

/** Units per field-pixel (1 yard = 1 world unit in 3D). */
const U = 1 / PX_PER_YARD;
const FIELD_LEN_U = FIELD_LENGTH * U;
const FIELD_WID_U = FIELD_WIDTH * U;

const MAX_PLAYERS = 14;

/** A swappable on-field player representation (box fallback or skinned FBX). */
interface Avatar {
  readonly group: THREE.Object3D;
  update(p: Player, jersey: number, trim: number, onFire: boolean, dt: number): void;
  hide(): void;
}

// Shared geometries (created once, reused by every avatar).
const G = {
  leg: new THREE.BoxGeometry(0.22, 0.82, 0.26),
  arm: new THREE.BoxGeometry(0.17, 0.6, 0.19),
  torso: new THREE.BoxGeometry(0.58, 0.72, 0.4),
  pads: new THREE.BoxGeometry(0.92, 0.3, 0.56),
  helmet: new THREE.SphereGeometry(0.27, 14, 12),
  mask: new THREE.BoxGeometry(0.06, 0.16, 0.34),
  ring: new THREE.TorusGeometry(0.85, 0.1, 8, 22),
  chevron: new THREE.ConeGeometry(0.32, 0.5, 4),
  nub: new THREE.SphereGeometry(0.17, 8, 6),
};

const SKIN = 0x8a5a3b;

/** An articulated, lightly-animated box avatar (fallback before the FBX loads). */
class BoxAvatar implements Avatar {
  readonly group = new THREE.Group();
  private readonly torsoMat: THREE.MeshStandardMaterial;
  private readonly padsMat: THREE.MeshStandardMaterial;
  private readonly helmetMat: THREE.MeshStandardMaterial;
  private readonly legL: THREE.Group;
  private readonly legR: THREE.Group;
  private readonly armL: THREE.Group;
  private readonly armR: THREE.Group;
  private readonly upper: THREE.Group;
  private readonly ring: THREE.Mesh;
  private readonly chevron: THREE.Mesh;
  private readonly nub: THREE.Mesh;
  private phase = Math.random() * Math.PI * 2;

  constructor() {
    this.torsoMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 });
    this.padsMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55 });
    this.helmetMat = new THREE.MeshStandardMaterial({ color: 0x222233, roughness: 0.35, metalness: 0.1 });
    const skinMat = new THREE.MeshStandardMaterial({ color: SKIN, roughness: 0.8 });

    // Legs (swing from the hips).
    this.legL = this.limb(G.leg, this.torsoMat, -0.16, 0.82, 0.41);
    this.legR = this.limb(G.leg, this.torsoMat, 0.16, 0.82, 0.41);

    // Upper body group (torso, pads, helmet, arms) so it can lean as one.
    this.upper = new THREE.Group();
    const torso = mesh(G.torso, this.torsoMat, 0, 1.12, 0);
    const pads = mesh(G.pads, this.padsMat, 0, 1.52, 0);
    const helmet = mesh(G.helmet, this.helmetMat, 0, 1.84, 0.02);
    const mask = mesh(G.mask, skinMat, 0, 1.8, 0.24);
    this.armL = this.limb(G.arm, skinMat, -0.5, 1.5, 0.31);
    this.armR = this.limb(G.arm, skinMat, 0.5, 1.5, 0.31);
    this.upper.add(torso, pads, helmet, mask, this.armL, this.armR);

    // Selection ring + bobbing chevron + ball nub.
    this.ring = new THREE.Mesh(G.ring, new THREE.MeshBasicMaterial({ color: 0xffe24a }));
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.05;
    this.ring.visible = false;
    this.chevron = new THREE.Mesh(G.chevron, new THREE.MeshBasicMaterial({ color: 0xffe24a }));
    this.chevron.rotation.x = Math.PI;
    this.chevron.position.y = 2.6;
    this.chevron.visible = false;
    this.nub = new THREE.Mesh(G.nub, new THREE.MeshStandardMaterial({ color: 0x7a3b12, roughness: 0.7 }));
    this.nub.position.set(0.55, 1.2, 0.1);
    this.nub.visible = false;

    this.group.add(this.legL, this.legR, this.upper, this.ring, this.chevron, this.nub);
    this.group.scale.setScalar(0.9);
  }

  /** A limb pivoting at a joint (mesh hangs below the joint group). */
  private limb(geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, half: number): THREE.Group {
    const joint = new THREE.Group();
    joint.position.set(x, y, 0);
    const m = new THREE.Mesh(geo, mat);
    m.position.y = -half;
    m.castShadow = true;
    joint.add(m);
    return joint;
  }

  update(p: Player, jersey: number, trim: number, onFire: boolean, dt: number): void {
    const g = this.group;
    g.visible = true;
    g.position.set(p.pos.x * U, 0, p.pos.y * U);

    const speed = Math.hypot(p.vel.x, p.vel.y);
    const moving = Math.min(1, speed / 150);

    if (p.isDown) {
      // Collapse + tip over when tackled.
      g.rotation.set(-Math.PI / 2.2, -p.facing, 0);
      g.position.y = 0.3;
      this.ring.visible = false;
      this.chevron.visible = false;
    } else {
      g.position.y = 0;
      // Face velocity; idle players keep their last facing.
      if (speed > 8) g.rotation.set(0, Math.atan2(p.vel.x, p.vel.y), 0);
      else g.rotation.set(0, Math.atan2(Math.cos(p.facing), Math.sin(p.facing)), 0);

      // Animate stride: exaggerated arm pump + leg swing, scaled by speed.
      this.phase += dt * (4 + moving * 14);
      const sw = Math.sin(this.phase) * (0.25 + moving * 0.85);
      this.legL.rotation.x = sw;
      this.legR.rotation.x = -sw;
      this.armL.rotation.x = -sw * 1.1;
      this.armR.rotation.x = sw * 1.1;
      // Forward lean proportional to speed.
      this.upper.rotation.x = -moving * 0.32;

      this.ring.visible = p.controlled;
      this.chevron.visible = p.controlled;
      if (p.controlled) this.chevron.position.y = 2.6 + Math.sin(this.phase * 0.6) * 0.12;
    }

    this.torsoMat.color.setHex(jersey);
    this.padsMat.color.setHex(jersey);
    this.helmetMat.color.setHex(trim);
    if (onFire) {
      this.torsoMat.emissive.setHex(0xff5a1e);
      this.torsoMat.emissiveIntensity = 0.3;
      this.padsMat.emissive.setHex(0xff5a1e);
      this.padsMat.emissiveIntensity = 0.3;
    } else {
      this.torsoMat.emissiveIntensity = 0;
      this.padsMat.emissiveIntensity = 0;
    }
    this.nub.visible = p.hasBall && !p.isDown;
  }

  hide(): void {
    this.group.visible = false;
  }
}

function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}

/** Facing offset so the model's front points along its movement direction. */
const MODEL_FORWARD = Math.PI;

/** A skinned, animated FBX avatar, tinted to the team color. */
class FbxAvatar implements Avatar {
  readonly group = new THREE.Group();
  private readonly mixer: THREE.AnimationMixer;
  private readonly action: THREE.AnimationAction | null;
  private readonly mats: THREE.MeshStandardMaterial[] = [];
  private readonly helmetMat: THREE.MeshStandardMaterial | null = null;
  private readonly lean = new THREE.Group();
  private readonly ring: THREE.Mesh;
  private readonly chevron: THREE.Mesh;
  private readonly nub: THREE.Mesh;
  private phase = Math.random() * Math.PI * 2;
  private prevYaw = 0;

  constructor(asset: CharacterAsset) {
    const inner = skeletonClone(asset.template);
    inner.scale.setScalar(asset.scale);
    inner.position.y = asset.groundOffset * asset.scale;
    inner.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.castShadow = true;
        const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7, metalness: 0.05 });
        m.material = mat;
        this.mats.push(mat);
      }
    });

    // Attach a team helmet (facemask + stripe) to the head bone so it animates.
    const headBone = inner.getObjectByName("Head");
    if (headBone) {
      inner.updateMatrixWorld(true);
      const ws = headBone.getWorldScale(new THREE.Vector3()).x || 1;
      const R = 0.16 / ws;
      this.helmetMat = new THREE.MeshStandardMaterial({ color: 0x222233, roughness: 0.35, metalness: 0.15 });
      const maskMat = new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.5 });
      const helmet = new THREE.Group();
      const dome = new THREE.Mesh(new THREE.SphereGeometry(R, 14, 12), this.helmetMat);
      dome.castShadow = true;
      const mask = new THREE.Mesh(new THREE.BoxGeometry(R * 1.3, R * 0.5, R * 0.18), maskMat);
      mask.position.set(0, -R * 0.25, R * 0.92);
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(R * 0.28, R * 0.4, R * 2), maskMat);
      stripe.position.set(0, R * 0.5, 0);
      helmet.add(dome, mask, stripe);
      helmet.position.set(0, R * 0.55, R * 0.1);
      headBone.add(helmet);
    }

    this.mixer = new THREE.AnimationMixer(inner);
    this.action = asset.clip ? this.mixer.clipAction(asset.clip) : null;
    this.action?.play();

    this.ring = new THREE.Mesh(G.ring, new THREE.MeshBasicMaterial({ color: 0xffe24a }));
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.05;
    this.ring.visible = false;
    this.chevron = new THREE.Mesh(G.chevron, new THREE.MeshBasicMaterial({ color: 0xffe24a }));
    this.chevron.rotation.x = Math.PI;
    this.chevron.position.y = 2.8;
    this.chevron.visible = false;
    this.nub = new THREE.Mesh(G.nub, new THREE.MeshStandardMaterial({ color: 0x7a3b12, roughness: 0.7 }));
    this.nub.scale.set(1.5, 1, 1);
    this.nub.position.set(0.34, 0.98, 0.2);
    this.nub.visible = false;

    // The lean group banks/leans the body; the holder group only yaws + positions,
    // so the ground ring / chevron / ball stay upright.
    this.lean.add(inner);
    this.group.add(this.lean, this.ring, this.chevron, this.nub);
  }

  update(p: Player, jersey: number, trim: number, onFire: boolean, dt: number): void {
    const g = this.group;
    g.visible = true;
    g.position.set(p.pos.x * U, 0, p.pos.y * U);

    const speed = Math.hypot(p.vel.x, p.vel.y);
    const moving = Math.min(1, speed / 150);
    const yaw = (speed > 8 ? Math.atan2(p.vel.x, p.vel.y) : Math.atan2(Math.cos(p.facing), Math.sin(p.facing))) + MODEL_FORWARD;
    let dyaw = yaw - this.prevYaw;
    while (dyaw > Math.PI) dyaw -= Math.PI * 2;
    while (dyaw < -Math.PI) dyaw += Math.PI * 2;
    this.prevYaw = yaw;
    g.rotation.y = yaw;

    if (p.isDown) {
      g.position.y = 0.25;
      this.lean.rotation.set(-Math.PI / 2.1, 0, 0);
      if (this.action) this.action.timeScale = 0;
      this.ring.visible = false;
      this.chevron.visible = false;
    } else {
      g.position.y = 0;
      // Forward lean with speed + bank into hard cuts.
      const bank = Math.max(-0.45, Math.min(0.45, (-dyaw / Math.max(dt, 1 / 120)) * 0.016 * moving));
      this.lean.rotation.set(moving * 0.17, 0, bank);
      if (this.action) {
        if (moving < 0.05) {
          this.action.time = 0;
          this.action.timeScale = 0;
        } else {
          this.action.timeScale = 0.4 + moving * 2.6;
        }
      }
      this.phase += dt;
      this.ring.visible = p.controlled;
      this.chevron.visible = p.controlled;
      if (p.controlled) this.chevron.position.y = 2.8 + Math.sin(this.phase * 4) * 0.12;
    }

    this.mixer.update(dt);

    for (const m of this.mats) {
      m.color.setHex(jersey);
      if (onFire) {
        m.emissive.setHex(0xff5a1e);
        m.emissiveIntensity = 0.3;
      } else {
        m.emissiveIntensity = 0;
      }
    }
    if (this.helmetMat) this.helmetMat.color.setHex(trim);
    this.nub.visible = p.hasBall && !p.isDown;
  }

  hide(): void {
    this.group.visible = false;
  }
}

/**
 * Three.js renderer for the in-play 3D view: a stadium with stands + goal posts, a
 * textured turf plane that receives soft shadows, 14 articulated animated players, a
 * spiraling ball, and a high camera that follows the action from behind the offense.
 */
export class Scene3D {
  readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly sun: THREE.DirectionalLight;

  private players: Avatar[] = [];
  private readonly ballGroup = new THREE.Group();
  private readonly ballMesh: THREE.Mesh;
  private readonly losMarker: THREE.Mesh;
  private readonly firstDownMarker: THREE.Mesh;

  private width = 1;
  private height = 1;
  private ballRoll = 0;

  private camPos = new THREE.Vector3(60, 14, 27);
  private camLook = new THREE.Vector3(70, 1.5, 27);

  constructor(canvas: HTMLCanvasElement, field: Field) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setClearColor(0x0a1622, 1);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.scene.background = this.makeSky();
    this.scene.fog = new THREE.Fog(0x223a55, 80, 200);

    this.camera = new THREE.PerspectiveCamera(52, 1, 0.1, 600);

    // Lighting: hemisphere fill + a sun that follows the action and casts shadows.
    this.scene.add(new THREE.HemisphereLight(0xcfe3ff, 0x2c5a32, 0.9));
    this.sun = new THREE.DirectionalLight(0xfff4e0, 1.15);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 90;
    const s = 30;
    this.sun.shadow.camera.left = -s;
    this.sun.shadow.camera.right = s;
    this.sun.shadow.camera.top = s;
    this.sun.shadow.camera.bottom = -s;
    this.sun.shadow.bias = -0.0008;
    this.scene.add(this.sun, this.sun.target);

    this.buildField(field);
    this.buildStadium();

    for (let i = 0; i < MAX_PLAYERS; i++) {
      const pm = new BoxAvatar();
      pm.hide();
      this.players.push(pm);
      this.scene.add(pm.group);
    }

    // Ball: a stretched ellipsoid that spirals in flight.
    this.ballMesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.32, 14, 12),
      new THREE.MeshStandardMaterial({ color: 0x8a4b22, roughness: 0.55 }),
    );
    this.ballMesh.scale.set(1.6, 0.95, 0.95);
    this.ballMesh.castShadow = true;
    const ballShadow = new THREE.Mesh(
      new THREE.CircleGeometry(0.3, 12),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28 }),
    );
    ballShadow.rotation.x = -Math.PI / 2;
    ballShadow.position.y = 0.02;
    ballShadow.name = "shadow";
    this.ballGroup.add(this.ballMesh, ballShadow);
    this.ballGroup.visible = false;
    this.scene.add(this.ballGroup);

    this.losMarker = this.buildMarker(0x3a6bff);
    this.firstDownMarker = this.buildMarker(0xffd23a);
    this.scene.add(this.losMarker, this.firstDownMarker);
  }

  private makeSky(): THREE.Texture {
    const c = document.createElement("canvas");
    c.width = 4;
    c.height = 256;
    const ctx = c.getContext("2d")!;
    const grad = ctx.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, "#0a1730");
    grad.addColorStop(0.55, "#1d3a5f");
    grad.addColorStop(1, "#3b6a8c");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 4, 256);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  private buildField(field: Field): void {
    const c = document.createElement("canvas");
    c.width = Math.round(FIELD_LENGTH);
    c.height = Math.round(FIELD_WIDTH);
    const ctx = c.getContext("2d")!;
    field.drawTexture(ctx);
    const tex = new THREE.CanvasTexture(c);
    tex.anisotropy = 8;
    tex.colorSpace = THREE.SRGBColorSpace;

    const geo = new THREE.PlaneGeometry(FIELD_LEN_U, FIELD_WID_U);
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.92 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(FIELD_LEN_U / 2, 0, FIELD_WID_U / 2);
    mesh.receiveShadow = true;
    this.scene.add(mesh);

    // A dark apron (sideline area) around the field so edges aren't floating.
    const apron = new THREE.Mesh(
      new THREE.PlaneGeometry(FIELD_LEN_U + 30, FIELD_WID_U + 22),
      new THREE.MeshStandardMaterial({ color: 0x123018, roughness: 1 }),
    );
    apron.rotation.x = -Math.PI / 2;
    apron.position.set(FIELD_LEN_U / 2, -0.05, FIELD_WID_U / 2);
    apron.receiveShadow = true;
    this.scene.add(apron);
  }

  private buildStadium(): void {
    // Goal posts at each end.
    this.scene.add(this.goalPost(ENDZONE_PX * U - 0.5));
    this.scene.add(this.goalPost(FIELD_LEN_U - ENDZONE_PX * U + 0.5));

    const crowd = this.makeCrowdTexture();
    const ad = this.makeAdTexture();
    const m = 4;
    const ext = 28;
    const sides: { x: number; z: number; ry: number; len: number }[] = [
      { x: FIELD_LEN_U / 2, z: -m, ry: Math.PI, len: FIELD_LEN_U + ext },
      { x: FIELD_LEN_U / 2, z: FIELD_WID_U + m, ry: 0, len: FIELD_LEN_U + ext },
      { x: -m, z: FIELD_WID_U / 2, ry: -Math.PI / 2, len: FIELD_WID_U + ext },
      { x: FIELD_LEN_U + m, z: FIELD_WID_U / 2, ry: Math.PI / 2, len: FIELD_WID_U + ext },
    ];
    for (const s of sides) this.scene.add(this.buildStand(s.x, s.z, s.ry, s.len, crowd, ad));

    // Light towers at the four corners.
    const corners: [number, number][] = [
      [-m - 3, -m - 3],
      [FIELD_LEN_U + m + 3, -m - 3],
      [-m - 3, FIELD_WID_U + m + 3],
      [FIELD_LEN_U + m + 3, FIELD_WID_U + m + 3],
    ];
    for (const [cx, cz] of corners) this.scene.add(this.lightTower(cx, cz));

    // Jumbotron above the right end zone, facing the field.
    this.scene.add(this.jumbotron(FIELD_LEN_U + m + 5, FIELD_WID_U / 2));
  }

  /** One stand: ad board at field level + two raked seating tiers + a roof line. */
  private buildStand(x: number, z: number, ry: number, len: number, crowd: THREE.Texture, ad: THREE.Texture): THREE.Group {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = ry;
    const concrete = new THREE.MeshStandardMaterial({ color: 0x3a4452, roughness: 1 });

    const adMat = new THREE.MeshStandardMaterial({ map: ad, roughness: 0.8, emissive: 0x111111 });
    const adBoard = new THREE.Mesh(new THREE.BoxGeometry(len, 2.4, 0.5), adMat);
    adBoard.position.set(0, 1.2, 0.4);
    g.add(adBoard);

    const crowdMat = new THREE.MeshStandardMaterial({ map: crowd, roughness: 1 });
    const lower = new THREE.Mesh(new THREE.BoxGeometry(len, 6.5, 5.5), crowdMat);
    lower.position.set(0, 3.6, 3.4);
    lower.rotation.x = -0.32;
    g.add(lower);

    const upper = new THREE.Mesh(new THREE.BoxGeometry(len, 6, 5.5), crowdMat);
    upper.position.set(0, 9.2, 8.2);
    upper.rotation.x = -0.32;
    g.add(upper);

    const roof = new THREE.Mesh(new THREE.BoxGeometry(len, 0.6, 8), concrete);
    roof.position.set(0, 13, 8);
    g.add(roof);

    const wall = new THREE.Mesh(new THREE.BoxGeometry(len, 1.4, 0.6), concrete);
    wall.position.set(0, 0.2, 0.1);
    g.add(wall);
    return g;
  }

  private lightTower(x: number, z: number): THREE.Group {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.35, 0.45, 22, 8),
      new THREE.MeshStandardMaterial({ color: 0x2a3038, roughness: 0.9 }),
    );
    pole.position.y = 11;
    g.add(pole);
    const bank = new THREE.Mesh(
      new THREE.BoxGeometry(5, 2.4, 0.6),
      new THREE.MeshStandardMaterial({ color: 0xfff6d8, emissive: 0xfff0c0, emissiveIntensity: 1.2 }),
    );
    bank.position.set(0, 21, 0);
    // Aim the bank toward the field center.
    bank.lookAt(FIELD_LEN_U / 2, 0, FIELD_WID_U / 2);
    g.add(bank);
    return g;
  }

  private jumbotron(x: number, z: number): THREE.Group {
    const g = new THREE.Group();
    g.position.set(x, 13, z);
    const frame = new THREE.Mesh(
      new THREE.BoxGeometry(1, 7, 13),
      new THREE.MeshStandardMaterial({ color: 0x1a1f26, roughness: 0.8 }),
    );
    g.add(frame);
    const screen = new THREE.Mesh(
      new THREE.PlaneGeometry(11, 5.5),
      new THREE.MeshStandardMaterial({ color: 0x0a2a4a, emissive: 0x1d5a8a, emissiveIntensity: 0.8 }),
    );
    screen.position.x = -0.55;
    screen.rotation.y = -Math.PI / 2;
    g.add(screen);
    const stem = new THREE.Mesh(
      new THREE.CylinderGeometry(0.4, 0.4, 13, 8),
      new THREE.MeshStandardMaterial({ color: 0x2a3038 }),
    );
    stem.position.y = -9.5;
    g.add(stem);
    return g;
  }

  private makeAdTexture(): THREE.Texture {
    const c = document.createElement("canvas");
    c.width = 512;
    c.height = 64;
    const ctx = c.getContext("2d")!;
    const panels = ["#1c6fd0", "#d03a3a", "#155a30", "#e6a91e", "#5a3aa0", "#0f8a8a"];
    const pw = 86;
    for (let i = 0, x = 0; x < 512; i++, x += pw) {
      ctx.fillStyle = panels[i % panels.length];
      ctx.fillRect(x, 0, pw - 4, 64);
      // Fake wordmark blocks.
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.fillRect(x + 14, 26, pw - 32, 6);
      ctx.fillRect(x + 24, 38, pw - 52, 5);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = THREE.RepeatWrapping;
    tex.repeat.set(6, 1);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  private goalPost(x: number): THREE.Group {
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0xf5d23a, roughness: 0.4, metalness: 0.3 });
    const cz = FIELD_WID_U / 2;
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 3, 8), mat);
    base.position.set(x, 1.5, cz);
    const cross = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 6.2, 8), mat);
    cross.rotation.x = Math.PI / 2;
    cross.position.set(x, 3, cz);
    const u1 = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 4, 8), mat);
    u1.position.set(x, 5, cz - 3);
    const u2 = u1.clone();
    u2.position.z = cz + 3;
    g.add(base, cross, u1, u2);
    return g;
  }

  private makeCrowdTexture(): THREE.Texture {
    const c = document.createElement("canvas");
    c.width = 256;
    c.height = 128;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#0c1420";
    ctx.fillRect(0, 0, 256, 128);
    const cols = ["#d8d8d8", "#ffd23a", "#e25b5b", "#5aa9ff", "#7bd88a", "#caa6ff", "#ff9a3c"];
    // Seating rows of speckled fans.
    const rowH = 9;
    for (let y = 4; y < 128; y += rowH) {
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.fillRect(0, y + rowH - 2, 256, 2);
      for (let x = 2; x < 256; x += 5) {
        ctx.fillStyle = cols[(Math.random() * cols.length) | 0];
        ctx.globalAlpha = 0.55 + Math.random() * 0.45;
        ctx.fillRect(x + (Math.random() * 2 - 1), y + (Math.random() * 3), 3, 4);
      }
    }
    ctx.globalAlpha = 1;
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(14, 2);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  private buildMarker(color: number): THREE.Mesh {
    const geo = new THREE.PlaneGeometry(0.2, FIELD_WID_U);
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85 });
    const m = new THREE.Mesh(geo, mat);
    m.rotation.x = -Math.PI / 2;
    m.position.y = 0.05;
    m.position.z = FIELD_WID_U / 2;
    return m;
  }

  resize(width: number, height: number, dpr: number): void {
    this.width = width;
    this.height = height;
    this.renderer.setPixelRatio(Math.min(dpr, 2));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  setVisible(v: boolean): void {
    this.canvas.style.display = v ? "block" : "none";
  }

  /** Swap the box-avatar pool for skinned FBX characters once the model has loaded. */
  setCharacter(asset: CharacterAsset): void {
    for (const a of this.players) this.scene.remove(a.group);
    this.players = [];
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const a = new FbxAvatar(asset);
      a.hide();
      this.players.push(a);
      this.scene.add(a.group);
    }
  }

  snapCamera(focusX: number, focusY: number, dir: number): void {
    this.computeCamTarget(focusX, focusY, dir, this.camPos, this.camLook);
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLook);
  }

  private computeCamTarget(
    focusX: number,
    focusY: number,
    dir: number,
    outPos: THREE.Vector3,
    outLook: THREE.Vector3,
  ): void {
    const fx = focusX * U;
    const fz = focusY * U;
    outPos.set(fx - dir * 13, 13.5, fz);
    outLook.set(fx + dir * 10, 1.5, fz);
  }

  sync(opts: {
    players: Player[];
    ball: Ball;
    colorFor: (p: Player) => { jersey: number; trim: number; onFire: boolean };
    focusX: number;
    focusY: number;
    dir: number;
    losX: number;
    firstDownX: number;
    shakeX: number;
    shakeY: number;
    dt: number;
  }): void {
    const { players, ball } = opts;
    for (let i = 0; i < this.players.length; i++) {
      const p = players[i];
      if (p) {
        const col = opts.colorFor(p);
        this.players[i].update(p, col.jersey, col.trim, col.onFire, opts.dt);
      } else {
        this.players[i].hide();
      }
    }

    if (ball.state === "held") {
      this.ballGroup.visible = false;
    } else {
      this.ballGroup.visible = true;
      this.ballGroup.position.set(ball.pos.x * U, ball.z * U + 0.1, ball.pos.y * U);
      const shadow = this.ballGroup.getObjectByName("shadow");
      if (shadow) shadow.position.y = -ball.z * U + 0.02 - 0.1;
      // Point the ball along its travel and spiral it; tumble end-over-end if loose.
      if (ball.state === "inAir") {
        this.ballRoll += opts.dt * 26;
        this.ballMesh.rotation.set(0, Math.atan2(ball.vel.x, ball.vel.y), this.ballRoll);
      } else if (ball.state === "loose") {
        this.ballRoll += opts.dt * 16;
        this.ballMesh.rotation.set(this.ballRoll, Math.atan2(ball.vel.x, ball.vel.y), this.ballRoll * 0.6);
      }
    }

    this.losMarker.position.x = opts.losX * U;
    this.firstDownMarker.position.x = opts.firstDownX * U;

    // Smooth camera follow + shake.
    const tp = _tmpPos;
    const tl = _tmpLook;
    this.computeCamTarget(opts.focusX, opts.focusY, opts.dir, tp, tl);
    // Tighter follow so the camera stays connected to decisive player movement.
    const t = Math.min(1, opts.dt * 9);
    this.camPos.lerp(tp, t);
    this.camLook.lerp(tl, Math.min(1, t * 1.3));
    this.camera.position.set(
      this.camPos.x + opts.shakeX * U * 0.5,
      this.camPos.y + opts.shakeY * U * 0.5,
      this.camPos.z,
    );
    this.camera.lookAt(this.camLook);

    // Keep the shadow frustum centered on the action.
    const fx = opts.focusX * U;
    const fz = opts.focusY * U;
    this.sun.position.set(fx - 14, 34, fz - 10);
    this.sun.target.position.set(fx, 0, fz);
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  project(worldX: number, worldY: number, heightPx: number): { x: number; y: number; visible: boolean } {
    _tmpVec.set(worldX * U, heightPx * U, worldY * U);
    _tmpVec.project(this.camera);
    return {
      x: (_tmpVec.x * 0.5 + 0.5) * this.width,
      y: (-_tmpVec.y * 0.5 + 0.5) * this.height,
      visible: _tmpVec.z < 1,
    };
  }
}

const _tmpPos = new THREE.Vector3();
const _tmpLook = new THREE.Vector3();
const _tmpVec = new THREE.Vector3();
