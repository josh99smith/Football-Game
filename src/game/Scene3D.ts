import * as THREE from "three";
import type { Player } from "./entities/Player";
import type { Ball } from "./entities/Ball";
import { Field, FIELD_LENGTH, FIELD_WIDTH, PX_PER_YARD } from "./Field";

/** Units per field-pixel (1 yard = 1 world unit in 3D). */
const U = 1 / PX_PER_YARD;
const FIELD_LEN_U = FIELD_LENGTH * U;
const FIELD_WID_U = FIELD_WIDTH * U;

const MAX_PLAYERS = 14;

/** A reusable 3D avatar: body + head + blob shadow + select ring + ball nub. */
class PlayerMesh {
  readonly group = new THREE.Group();
  private readonly bodyMat: THREE.MeshStandardMaterial;
  private readonly headMat: THREE.MeshStandardMaterial;
  private readonly ring: THREE.Mesh;
  private readonly nub: THREE.Mesh;

  constructor(bodyGeo: THREE.CylinderGeometry, headGeo: THREE.SphereGeometry, shadowGeo: THREE.CircleGeometry, ringGeo: THREE.TorusGeometry, nubGeo: THREE.SphereGeometry) {
    this.bodyMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7, metalness: 0.05 });
    this.headMat = new THREE.MeshStandardMaterial({ color: 0x222233, roughness: 0.5 });

    const body = new THREE.Mesh(bodyGeo, this.bodyMat);
    body.position.y = 0.72;
    const head = new THREE.Mesh(headGeo, this.headMat);
    head.position.y = 1.5;

    const shadow = new THREE.Mesh(
      shadowGeo,
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28 }),
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.02;

    this.ring = new THREE.Mesh(
      ringGeo,
      new THREE.MeshBasicMaterial({ color: 0xffe24a }),
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.06;
    this.ring.visible = false;

    this.nub = new THREE.Mesh(
      nubGeo,
      new THREE.MeshStandardMaterial({ color: 0x7a3b12, roughness: 0.6 }),
    );
    this.nub.position.set(0.5, 0.9, 0.2);
    this.nub.visible = false;

    this.group.add(shadow, this.ring, body, head, this.nub);
  }

  update(p: Player, jersey: number, trim: number, onFire: boolean): void {
    const g = this.group;
    g.visible = true;
    g.position.set(p.pos.x * U, 0, p.pos.y * U);
    g.rotation.y = -p.facing;

    if (p.isDown) {
      g.scale.set(1, 0.42, 1);
    } else {
      g.scale.set(1, 1, 1);
    }

    this.bodyMat.color.setHex(jersey);
    this.headMat.color.setHex(trim);
    if (onFire) {
      this.bodyMat.emissive.setHex(0xff5a1e);
      this.bodyMat.emissiveIntensity = 0.6;
    } else {
      this.bodyMat.emissiveIntensity = 0;
    }
    this.ring.visible = p.controlled && !p.isDown;
    this.nub.visible = p.hasBall;
  }

  hide(): void {
    this.group.visible = false;
  }
}

/**
 * Three.js renderer for the in-play 3D view: a textured turf plane, 14 reusable
 * player avatars, the ball, scrimmage/first-down markers, and a high camera that
 * follows the action from behind the offense. Game logic stays 2D; this only draws.
 */
export class Scene3D {
  readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;

  private readonly players: PlayerMesh[] = [];
  private readonly ballGroup = new THREE.Group();
  private readonly losMarker: THREE.Mesh;
  private readonly firstDownMarker: THREE.Mesh;

  private width = 1;
  private height = 1;

  // Smoothed camera state.
  private camPos = new THREE.Vector3(60, 14, 27);
  private camLook = new THREE.Vector3(70, 1.5, 27);

  constructor(canvas: HTMLCanvasElement, field: Field) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setClearColor(0x081c12, 1);

    this.scene.background = new THREE.Color(0x0a1f16);
    this.scene.fog = new THREE.Fog(0x0a1f16, 70, 150);

    this.camera = new THREE.PerspectiveCamera(52, 1, 0.1, 600);

    // Lighting: soft sky/ground fill + a key light for shading.
    this.scene.add(new THREE.HemisphereLight(0xbfe0ff, 0x2c5a32, 0.95));
    const key = new THREE.DirectionalLight(0xffffff, 0.9);
    key.position.set(-0.4, 1, 0.3);
    this.scene.add(key);

    // Turf plane with a baked markings texture.
    this.scene.add(this.buildField(field));

    // Player pool.
    const bodyGeo = new THREE.CylinderGeometry(0.42, 0.5, 1.45, 12);
    const headGeo = new THREE.SphereGeometry(0.34, 12, 10);
    const shadowGeo = new THREE.CircleGeometry(0.7, 16);
    const ringGeo = new THREE.TorusGeometry(0.8, 0.1, 8, 20);
    const nubGeo = new THREE.SphereGeometry(0.18, 8, 6);
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const pm = new PlayerMesh(bodyGeo, headGeo, shadowGeo, ringGeo, nubGeo);
      pm.hide();
      this.players.push(pm);
      this.scene.add(pm.group);
    }

    // Ball: a stretched ellipsoid + ground shadow.
    const ballMesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.3, 12, 10),
      new THREE.MeshStandardMaterial({ color: 0x8a4b22, roughness: 0.6 }),
    );
    ballMesh.scale.set(1.5, 0.95, 0.95);
    const ballShadow = new THREE.Mesh(
      new THREE.CircleGeometry(0.3, 12),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.3 }),
    );
    ballShadow.rotation.x = -Math.PI / 2;
    ballShadow.position.y = 0.02;
    ballShadow.name = "shadow";
    this.ballGroup.add(ballMesh, ballShadow);
    this.ballGroup.visible = false;
    this.scene.add(this.ballGroup);

    // Field markers (thin flat strips across the width).
    this.losMarker = this.buildMarker(0x3a6bff);
    this.firstDownMarker = this.buildMarker(0xffd23a);
    this.scene.add(this.losMarker, this.firstDownMarker);
  }

  private buildField(field: Field): THREE.Mesh {
    const tex = this.bakeFieldTexture(field);
    const geo = new THREE.PlaneGeometry(FIELD_LEN_U, FIELD_WID_U);
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(FIELD_LEN_U / 2, 0, FIELD_WID_U / 2);
    return mesh;
  }

  private bakeFieldTexture(field: Field): THREE.CanvasTexture {
    const c = document.createElement("canvas");
    // Half-res of field pixels keeps the texture sharp but light.
    c.width = Math.round(FIELD_LENGTH);
    c.height = Math.round(FIELD_WIDTH);
    const ctx = c.getContext("2d")!;
    field.drawTexture(ctx);
    const tex = new THREE.CanvasTexture(c);
    tex.anisotropy = 4;
    tex.needsUpdate = true;
    return tex;
  }

  private buildMarker(color: number): THREE.Mesh {
    const geo = new THREE.PlaneGeometry(0.18, FIELD_WID_U);
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8 });
    const m = new THREE.Mesh(geo, mat);
    m.rotation.x = -Math.PI / 2;
    m.position.y = 0.04;
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

  /** Snap the camera to a focus immediately (used at the snap to avoid a swoop). */
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
    const BACK = 13;
    const HEIGHT = 13.5;
    const AHEAD = 10;
    outPos.set(fx - dir * BACK, HEIGHT, fz);
    outLook.set(fx + dir * AHEAD, 1.5, fz);
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
        this.players[i].update(p, col.jersey, col.trim, col.onFire);
      } else {
        this.players[i].hide();
      }
    }

    // Ball (shown only when not carried).
    if (ball.state === "held") {
      this.ballGroup.visible = false;
    } else {
      this.ballGroup.visible = true;
      this.ballGroup.position.set(ball.pos.x * U, ball.z * U, ball.pos.y * U);
      const shadow = this.ballGroup.getObjectByName("shadow");
      if (shadow) shadow.position.y = -ball.z * U + 0.02;
    }

    this.losMarker.position.x = opts.losX * U;
    this.firstDownMarker.position.x = opts.firstDownX * U;

    // Smooth camera follow.
    const tp = _tmpPos;
    const tl = _tmpLook;
    this.computeCamTarget(opts.focusX, opts.focusY, opts.dir, tp, tl);
    const t = 1 - Math.pow(0.001, opts.dt); // smoothing
    this.camPos.lerp(tp, t);
    this.camLook.lerp(tl, t);
    // Apply screen-shake as a small camera jitter.
    this.camera.position.set(
      this.camPos.x + opts.shakeX * U * 0.5,
      this.camPos.y + opts.shakeY * U * 0.5,
      this.camPos.z,
    );
    this.camera.lookAt(this.camLook);
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  /** Project a field-world point (+ pixel height) to overlay screen pixels. */
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
