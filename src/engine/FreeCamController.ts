import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

/**
 * A reusable free-look camera: OrbitControls driven from a full-screen, touch-action:none input
 * layer (so it gets multi-touch pinch/pan that the game canvas would otherwise eat), plus a small
 * always-on-top toggle button so it can be turned off again even while the orbit layer covers the
 * 2D UI beneath it. Used by the instant replay (and mirrors the debug overlay's camera).
 *
 * The owner wires `onChange` to enable/disable its own follow-camera while free-look is active.
 */
export class FreeCamController {
  active = false;
  onChange?: (active: boolean) => void;
  private readonly camera: THREE.Camera;
  private readonly controls: OrbitControls;
  private readonly layer: HTMLDivElement;
  private readonly btn: HTMLButtonElement;
  private readonly fwd = new THREE.Vector3();
  // Remembered camera pose, so re-entering free-look returns to the user's picked spot (locked)
  // instead of snapping back to wherever the auto camera has since moved.
  private readonly savedPos = new THREE.Vector3();
  private readonly savedTarget = new THREE.Vector3();
  private hasSaved = false;

  constructor(camera: THREE.Camera) {
    this.camera = camera;
    this.layer = document.createElement("div");
    this.layer.style.cssText =
      "position:fixed;inset:0;z-index:5;touch-action:none;display:none;background:transparent;";
    document.body.appendChild(this.layer);

    this.btn = document.createElement("button");
    this.btn.textContent = "FREE CAM";
    this.btn.style.cssText =
      "position:fixed;left:10px;top:10px;z-index:20;display:none;padding:8px 12px;font:700 13px " +
      "'Trebuchet MS',system-ui,sans-serif;color:#fff;background:rgba(20,28,38,0.82);border:1px " +
      "solid rgba(255,255,255,0.5);border-radius:8px;-webkit-tap-highlight-color:transparent;";
    this.btn.addEventListener("click", () => this.setActive(!this.active));
    document.body.appendChild(this.btn);

    this.controls = new OrbitControls(this.camera, this.layer);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.enabled = false;
  }

  /** Show/hide the toggle button (call when entering/leaving the mode that offers free-look). */
  show(visible: boolean): void {
    this.btn.style.display = visible ? "block" : "none";
    if (!visible) this.setActive(false);
  }

  setActive(on: boolean): void {
    this.active = on;
    this.controls.enabled = on;
    this.layer.style.display = on ? "block" : "none";
    this.btn.textContent = on ? "EXIT CAM" : "FREE CAM";
    if (on) {
      if (this.hasSaved) {
        // Lock back onto the user's last picked position/angle (don't snap to the auto cam).
        this.camera.position.copy(this.savedPos);
        this.controls.target.copy(this.savedTarget);
      } else {
        // First time this replay: center the orbit on whatever the camera is currently looking at.
        this.camera.getWorldDirection(this.fwd);
        this.controls.target.copy(this.camera.position).addScaledVector(this.fwd, 16);
      }
      this.controls.update();
    } else {
      // Remember where the user left the camera so the next FREE CAM returns to it.
      this.savedPos.copy(this.camera.position);
      this.savedTarget.copy(this.controls.target);
      this.hasSaved = true;
    }
    this.onChange?.(on);
  }

  /** Forget the saved pose so the next activation frames from the live camera (a fresh replay). */
  reset(): void {
    this.hasSaved = false;
  }

  /** Advance damping each frame while active. */
  update(): void {
    if (this.controls.enabled) this.controls.update();
  }

  dispose(): void {
    this.controls.dispose();
    this.layer.remove();
    this.btn.remove();
  }
}
