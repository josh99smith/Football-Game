import GUI from "lil-gui";
import * as THREE from "three";
import type { Ragdoll } from "../physics/Ragdoll";
import type { PhysicsWorld } from "../physics/PhysicsWorld";
import type { LocomotionController } from "../physics/LocomotionController";
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
export function createMotionDebugPanel(ragdoll: Ragdoll, physics: PhysicsWorld, loco?: LocomotionController): GUI {
  const gui = new GUI({ title: `Motion — Slice 3  (${specMass(ragdoll.spec).toFixed(0)} kg)` });

  const state = {
    stiffness: 0.8,
    Kp: ragdoll.Kp,
    Kd: ragdoll.Kd,
    maxImpulse: ragdoll.maxImpulse,
    substeps: physics.substeps,
    pinAnchor: false,
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
  sim.add(state, "pinAnchor").name("Pin (hang)").onChange((v: boolean) => {
    if (v) { loco?.deactivate(); ragdoll.setAnchorPinned(true); }
    else if (loco) loco.activate();
    else ragdoll.setAnchorPinned(false);
  });

  const act = gui.addFolder("Actions");
  act.add(state, "holdPose").name("Hold Pose");
  act.add(state, "reach").name("Reach R");
  act.add(state, "goLimp").name("Go Limp");
  act.add(state, "nudge").name("Nudge");
  act.add(state, "reset").name("Reset");

  if (loco) {
    const locoState = {
      walk: false,
      desiredSpeed: 1.2,
      assist: loco.assist,
      uprightKp: loco.uprightKp,
      uprightKd: loco.uprightKd,
      comKp: loco.comKp,
      comKd: loco.comKd,
      cycleTime: loco.cycleTime,
      anklePush: loco.anklePush,
      stepAhead: loco.stepAhead,
      pushoff: loco.pushoff,
      legStiffness: loco.legStiffness,
      armStiffness: loco.armStiffness,
      hipAmp: loco.gait.hipAmp,
      kneeSwing: loco.gait.kneeSwing,
      armAmp: loco.gait.armAmp,
      spineLean: loco.gait.spineLean,
      stand: () => { locoState.walk = false; loco.setMode("idle"); loco.desiredSpeed = 0; },
      restand: () => { locoState.walk = false; loco.activate(); loco.desiredSpeed = 0; },
    };
    const lf = gui.addFolder("Locomotion (Slice 3 — reference gait)");
    lf.add(locoState, "walk").name("Walk").listen().onChange((v: boolean) => {
      loco.setMode(v ? "walk" : "idle");
      loco.desiredSpeed = v ? locoState.desiredSpeed : 0;
    });
    lf.add(locoState, "desiredSpeed", 0, 3.5, 0.05).name("Speed (m/s)").onChange((v: number) => {
      if (locoState.walk) loco.desiredSpeed = v;
    });
    lf.add(locoState, "hipAmp", 5, 50, 1).name("Hip swing °").onChange((v: number) => (loco.gait.hipAmp = v));
    lf.add(locoState, "kneeSwing", 20, 90, 1).name("Knee lift °").onChange((v: number) => (loco.gait.kneeSwing = v));
    lf.add(locoState, "armAmp", 0, 60, 1).name("Arm swing °").onChange((v: number) => (loco.gait.armAmp = v));
    lf.add(locoState, "spineLean", 0, 25, 0.5).name("Trunk lean °").onChange((v: number) => (loco.gait.spineLean = v));
    lf.add(locoState, "cycleTime", 0.5, 2.0, 0.01).name("Cycle time").onChange((v: number) => (loco.cycleTime = v));
    lf.add(locoState, "anklePush", 0, 0.7, 0.01).name("Toe-off °").onChange((v: number) => (loco.anklePush = v));
    lf.add(locoState, "stepAhead", 0, 0.5, 0.01).name("Step ahead").onChange((v: number) => (loco.stepAhead = v));
    lf.add(locoState, "pushoff", 0, 1.5, 0.01).name("Push-off").onChange((v: number) => (loco.pushoff = v));
    lf.add(locoState, "assist", 0, 1, 0.01).name("Balance assist").onChange((v: number) => (loco.assist = v));
    lf.add(locoState, "legStiffness", 0, 1, 0.01).name("Leg stiffness").onChange((v: number) => (loco.legStiffness = v));
    lf.add(locoState, "armStiffness", 0, 1, 0.01).name("Arm stiffness").onChange((v: number) => (loco.armStiffness = v));
    const bal = lf.addFolder("Assist gains");
    bal.close();
    bal.add(locoState, "uprightKp", 0, 600, 5).onChange((v: number) => (loco.uprightKp = v));
    bal.add(locoState, "uprightKd", 0, 100, 1).onChange((v: number) => (loco.uprightKd = v));
    bal.add(locoState, "comKp", 0, 120, 1).onChange((v: number) => (loco.comKp = v));
    bal.add(locoState, "comKd", 0, 60, 1).onChange((v: number) => (loco.comKd = v));
    lf.add(locoState, "stand").name("Stand still");
    lf.add(locoState, "restand").name("Re-stand (reset)");
  }

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
