import GUI from "lil-gui";
import * as THREE from "three";
import type { Ragdoll } from "../physics/Ragdoll";
import type { PhysicsWorld } from "../physics/PhysicsWorld";
import { specMass } from "../physics/RagdollConfig";

/** Build a sample "reach" pose (raise + bend the right arm) to demo posing-by-angle. */
function reachPose(): Record<string, THREE.Quaternion> {
  const q = (ax: THREE.Vector3, a: number) => new THREE.Quaternion().setFromAxisAngle(ax, a);
  const X = new THREE.Vector3(1, 0, 0);
  return {
    shoulderR: q(X, -1.5), // both arms held out horizontally in front
    shoulderL: q(X, -1.5),
    elbowR: q(X, -0.3),
    elbowL: q(X, -0.3),
  };
}

/**
 * Live tuning surface for the motion engine (Slice 1): the central per-joint stiffness
 * knob, PD gains, solver substeps, pelvis pin, and Hold/Limp/Nudge/Reset/Pose actions.
 */
export function createMotionDebugPanel(ragdoll: Ragdoll, physics: PhysicsWorld): GUI {
  const gui = new GUI({ title: `Motion — Slice 1  (${specMass(ragdoll.spec).toFixed(0)} kg)` });

  const state = {
    stiffness: 0.8,
    Kp: ragdoll.Kp,
    Kd: ragdoll.Kd,
    maxImpulse: ragdoll.maxImpulse,
    substeps: physics.substeps,
    pinAnchor: true,
    holdPose: () => {
      ragdoll.resetTargets();
      state.stiffness = 0.85;
      ragdoll.setStiffness(0.85);
    },
    goLimp: () => {
      state.stiffness = 0;
      ragdoll.setLimp();
    },
    reach: () => {
      ragdoll.setTargetPose(reachPose());
      state.stiffness = 0.9;
      ragdoll.setStiffness(0.9);
    },
    reset: () => {
      ragdoll.reset();
      state.stiffness = 0.8;
      ragdoll.setStiffness(0.8);
    },
    nudge: () => ragdoll.nudge(),
  };

  const muscle = gui.addFolder("Muscle");
  muscle.add(state, "stiffness", 0, 1, 0.01).name("Stiffness (all)").listen().onChange((v: number) => ragdoll.setStiffness(v));
  muscle.add(state, "Kp", 0, 3000, 10).name("Kp (gain)").onChange((v: number) => (ragdoll.Kp = v));
  muscle.add(state, "Kd", 0, 400, 1).name("Kd (damp)").onChange((v: number) => (ragdoll.Kd = v));
  muscle.add(state, "maxImpulse", 1, 200, 1).name("Torque clamp").onChange((v: number) => (ragdoll.maxImpulse = v));

  const sim = gui.addFolder("Sim");
  sim.add(state, "substeps", 1, 8, 1).onChange((v: number) => (physics.substeps = v));
  sim.add(state, "pinAnchor").name("Pin (hang)").onChange((v: boolean) => ragdoll.setAnchorPinned(v));

  const act = gui.addFolder("Actions");
  act.add(state, "holdPose").name("Hold Pose");
  act.add(state, "reach").name("Reach R");
  act.add(state, "goLimp").name("Go Limp");
  act.add(state, "nudge").name("Nudge");
  act.add(state, "reset").name("Reset");

  const pj = gui.addFolder("Per-joint stiffness");
  pj.close();
  const perJoint: Record<string, number> = {};
  for (const j of ragdoll.spec.joints) {
    perJoint[j.name] = j.stiffness;
    pj.add(perJoint, j.name, 0, 1, 0.01).onChange((v: number) => ragdoll.setJointStiffness(j.name, v));
  }

  ragdoll.setStiffness(state.stiffness);
  return gui;
}
