/**
 * The posing contract: FK down the hierarchy, the three drag behaviours
 * (translate / rotate-parent-bone / 2-bone IK), and the serialization that
 * lets a host store a pose as plain JSON.
 */

import {
  FiggiePose, ROOT_RANGE, defaultPose, normalizeAngle, poseEquals, resolveDrag,
  sanitizePose, solveWorld,
} from '../pose';
import { Turn, projectTurn, projectYaw, turnQuat } from '../view';
import { DRAG_TARGETS, RIG_HEIGHT, SKELETON, dragTargetFor, restJoint } from '../skeleton';

const target = (joint: string) => dragTargetFor(joint as never)!;

describe('the rest skeleton', () => {
  it('stands exactly RIG_HEIGHT tall, feet on the floor', () => {
    const w = solveWorld(defaultPose());
    // Head ball radius 10.2 above the head joint reaches the full height.
    expect(w.head.y + 10.2).toBeCloseTo(RIG_HEIGHT, 0);
    expect(w.ankleL.y).toBeCloseTo(6, 6); // ankle sits a foot's height up
    expect(w.ankleR.y).toBeCloseTo(6, 6);
  });

  it('is a T-pose wider than it is tall, like the Stewie reference', () => {
    const w = solveWorld(defaultPose());
    expect(w.wristL.x).toBeCloseTo(-35.5, 6);
    expect(w.wristR.x).toBeCloseTo(35.5, 6);
    expect(w.wristL.y).toBeCloseTo(w.shoulderL.y, 6); // arms level in T
  });

  it('lists parents before children, so one forward walk solves it', () => {
    const seen = new Set<string>();
    for (const j of SKELETON) {
      if (j.parent) expect(seen.has(j.parent)).toBe(true);
      seen.add(j.id);
    }
  });

  it('keeps every joint in the posing plane — depth belongs to flesh', () => {
    // The drag unprojection assumes z = 0 for every joint; a joint with a
    // rest z would be grabbed somewhere its knob doesn't render.
    for (const j of SKELETON) expect(j.dz).toBe(0);
  });
});

describe('FK drags (rotate the bone ending at the joint)', () => {
  it('dragging an elbow swings the upper arm and carries the wrist rigidly', () => {
    // Pull the left elbow straight down: the upper arm should point down
    // from the shoulder, and the forearm ride along at its rest bend (none).
    const w0 = solveWorld(defaultPose());
    const p = resolveDrag(defaultPose(), target('elbowL'), w0.shoulderL.x, w0.shoulderL.y - 13.5);
    const w = solveWorld(p);
    expect(w.elbowL.x).toBeCloseTo(w0.shoulderL.x, 5);
    expect(w.elbowL.y).toBeCloseTo(w0.shoulderL.y - 13.5, 5);
    // Forearm kept its straight-line relationship — the subtree followed.
    expect(w.wristL.x).toBeCloseTo(w.elbowL.x, 5);
    expect(w.wristL.y).toBeCloseTo(w.elbowL.y - 12.5, 5);
  });

  it('bending the spine carries chest, arms and head — the whole hierarchy', () => {
    const w0 = solveWorld(defaultPose());
    // Rotate the lower torso 90°: point the spine joint out to the left.
    const p = resolveDrag(defaultPose(), target('spine'), w0.root.x - 8, w0.root.y);
    const w = solveWorld(p);
    // Head swings from above the root to beside it (lying down).
    expect(w.head.y).toBeCloseTo(w.root.y + 0, 0);
    expect(w.head.x).toBeLessThan(w.root.x - 20);
    // The arm span is now vertical — the arms rode the torso.
    expect(Math.abs(w.wristL.y - w.wristR.y)).toBeGreaterThan(60);
  });

  it('bone lengths never change, whatever the drag asks for', () => {
    // Drag the elbow somewhere far outside the arm's reach: the joint
    // follows the DIRECTION only, at its own length.
    const w0 = solveWorld(defaultPose());
    const p = resolveDrag(defaultPose(), target('elbowL'), w0.shoulderL.x - 500, w0.shoulderL.y + 500);
    const w = solveWorld(p);
    const len = Math.hypot(w.elbowL.x - w.shoulderL.x, w.elbowL.y - w.shoulderL.y);
    expect(len).toBeCloseTo(13.5, 5);
  });

  it('a drag landing exactly on the pivot changes nothing', () => {
    const w0 = solveWorld(defaultPose());
    const p = resolveDrag(defaultPose(), target('elbowL'), w0.shoulderL.x, w0.shoulderL.y);
    expect(poseEquals(p, defaultPose())).toBe(true);
  });

  it('never mutates the pose it was handed', () => {
    const pose = defaultPose();
    resolveDrag(pose, target('elbowL'), 0, 0);
    resolveDrag(pose, target('root'), 10, 10);
    expect(pose).toEqual(defaultPose());
  });
});

describe('root drag (translate)', () => {
  it('carries the whole figure without re-posing it', () => {
    const bent = resolveDrag(defaultPose(), target('elbowL'), -20, 90);
    const moved = resolveDrag(bent, target('root'), 12, 40);
    const w = solveWorld(moved);
    expect(w.root.x).toBeCloseTo(12, 6);
    expect(w.root.y).toBeCloseTo(40, 6);
    // The elbow pose survived the move verbatim.
    expect(moved.angles).toEqual(bent.angles);
  });

  it('clamps to the stage so the figure cannot be lost off-canvas', () => {
    const p = resolveDrag(defaultPose(), target('root'), 10000, -10000);
    expect(p.rootX).toBe(ROOT_RANGE.x);
    expect(p.rootY).toBe(-ROOT_RANGE.yDown);
  });
});

describe('2-bone IK (wrists and ankles)', () => {
  it('lands the wrist exactly on a reachable target', () => {
    const w0 = solveWorld(defaultPose());
    const tx = w0.shoulderL.x - 10;
    const ty = w0.shoulderL.y - 18;
    const p = resolveDrag(defaultPose(), target('wristL'), tx, ty);
    const w = solveWorld(p);
    expect(w.wristL.x).toBeCloseTo(tx, 4);
    expect(w.wristL.y).toBeCloseTo(ty, 4);
    // Both bones kept their lengths — the elbow bent, nothing stretched.
    expect(Math.hypot(w.elbowL.x - w.shoulderL.x, w.elbowL.y - w.shoulderL.y)).toBeCloseTo(13.5, 5);
    expect(Math.hypot(w.wristL.x - w.elbowL.x, w.wristL.y - w.elbowL.y)).toBeCloseTo(12.5, 5);
  });

  it('clamps an out-of-reach target to full extension toward it', () => {
    const w0 = solveWorld(defaultPose());
    const p = resolveDrag(defaultPose(), target('wristL'), w0.shoulderL.x - 100, w0.shoulderL.y - 100);
    const w = solveWorld(p);
    const d = Math.hypot(w.wristL.x - w0.shoulderL.x, w.wristL.y - w0.shoulderL.y);
    expect(d).toBeCloseTo(13.5 + 12.5, 1); // full reach, no stretching
    // …and it points AT the target.
    const ang = Math.atan2(w.wristL.y - w0.shoulderL.y, w.wristL.x - w0.shoulderL.x);
    expect(ang).toBeCloseTo(Math.atan2(-100, -100), 3);
  });

  it('keeps the elbow on the side it already bends toward', () => {
    // Pre-bend the elbow one way, then IK nearby: the bend sign must hold
    // (an elbow that snapped sides mid-drag would visibly pop).
    const w0 = solveWorld(defaultPose());
    let p = resolveDrag(defaultPose(), target('wristL'), w0.shoulderL.x - 16, w0.shoulderL.y + 12);
    const sign = (pose: FiggiePose) => {
      const w = solveWorld(pose);
      return Math.sign(
        (w.elbowL.x - w.shoulderL.x) * (w.wristL.y - w.shoulderL.y)
        - (w.elbowL.y - w.shoulderL.y) * (w.wristL.x - w.shoulderL.x),
      );
    };
    const before = sign(p);
    expect(before).not.toBe(0);
    p = resolveDrag(p, target('wristL'), w0.shoulderL.x - 18, w0.shoulderL.y + 6);
    expect(sign(p)).toBe(before);
  });

  it('solves ankles the same way, through the leg chain', () => {
    const w0 = solveWorld(defaultPose());
    const tx = w0.hipL.x + 12;
    const ty = w0.hipL.y - 30;
    const p = resolveDrag(defaultPose(), target('ankleL'), tx, ty);
    const w = solveWorld(p);
    expect(w.ankleL.x).toBeCloseTo(tx, 4);
    expect(w.ankleL.y).toBeCloseTo(ty, 4);
  });
});

// A host's IK toggle: with ik = false a chain end poses as plain FK — only
// the grabbed joint moves; its parent (the elbow / knee) and everything
// else stays nailed in place.
describe('IK off (ik = false): chain ends pose as plain FK', () => {
  it('swings the wrist about an elbow that does not move', () => {
    const w0 = solveWorld(defaultPose());
    // Pull the wrist to straight below the elbow (one forearm length away).
    const p = resolveDrag(
      defaultPose(), target('wristL'), w0.elbowL.x, w0.elbowL.y - 12.5, 0, false,
    );
    const w = solveWorld(p);
    // Only the forearm's rotation changed — nothing upstream moved.
    expect(Object.keys(p.angles)).toEqual(['wristL']);
    expect(w.elbowL.x).toBeCloseTo(w0.elbowL.x, 6);
    expect(w.elbowL.y).toBeCloseTo(w0.elbowL.y, 6);
    expect(w.shoulderL.x).toBeCloseTo(w0.shoulderL.x, 6);
    expect(w.shoulderL.y).toBeCloseTo(w0.shoulderL.y, 6);
    // The wrist orbits the elbow at bone length onto the finger's angle.
    expect(w.wristL.x).toBeCloseTo(w0.elbowL.x, 4);
    expect(w.wristL.y).toBeCloseTo(w0.elbowL.y - 12.5, 4);
  });

  it('swings the ankle about a knee that does not move', () => {
    const w0 = solveWorld(defaultPose());
    const p = resolveDrag(
      defaultPose(), target('ankleL'), w0.kneeL.x + 20, w0.kneeL.y, 0, false,
    );
    const w = solveWorld(p);
    expect(Object.keys(p.angles)).toEqual(['ankleL']);
    expect(w.kneeL.x).toBeCloseTo(w0.kneeL.x, 6);
    expect(w.kneeL.y).toBeCloseTo(w0.kneeL.y, 6);
    expect(w.hipL.x).toBeCloseTo(w0.hipL.x, 6);
    expect(w.hipL.y).toBeCloseTo(w0.hipL.y, 6);
    // Shin length preserved; ankle tracks the finger's direction.
    const shin = Math.hypot(w.ankleL.x - w.kneeL.x, w.ankleL.y - w.kneeL.y);
    const shin0 = Math.hypot(w0.ankleL.x - w0.kneeL.x, w0.ankleL.y - w0.kneeL.y);
    expect(shin).toBeCloseTo(shin0, 5);
    expect(w.ankleL.x).toBeGreaterThan(w.kneeL.x);
    expect(Math.abs(w.ankleL.y - w.kneeL.y)).toBeLessThan(1e-4);
  });

  it('still rotates about the view axis when yawed — the parent stays put', () => {
    const YAW = 0.9;
    const w0 = solveWorld(defaultPose());
    const e0 = projectYaw(w0.elbowL.x, w0.elbowL.y, w0.elbowL.z, YAW, w0.root.x);
    const p = resolveDrag(
      defaultPose(), target('wristL'), e0.px, e0.py - 10, YAW, false,
    );
    const w = solveWorld(p);
    // The elbow's world position is untouched by the yawed wrist swing.
    expect(w.elbowL.x).toBeCloseTo(w0.elbowL.x, 6);
    expect(w.elbowL.y).toBeCloseTo(w0.elbowL.y, 6);
    expect(w.elbowL.z).toBeCloseTo(w0.elbowL.z, 6);
    // And the wrist's PROJECTION orbits it in the view plane at the
    // apparent radius, pointing at the finger.
    const wp = projectYaw(w.wristL.x, w.wristL.y, w.wristL.z, YAW, w0.root.x);
    const r0 = Math.hypot(
      projectYaw(w0.wristL.x, w0.wristL.y, w0.wristL.z, YAW, w0.root.x).px - e0.px,
      projectYaw(w0.wristL.x, w0.wristL.y, w0.wristL.z, YAW, w0.root.x).py - e0.py,
    );
    expect(Math.hypot(wp.px - e0.px, wp.py - e0.py)).toBeCloseTo(r0, 4);
    expect(Math.atan2(wp.py - e0.py, wp.px - e0.px)).toBeCloseTo(Math.atan2(-10, 0), 4);
  });

  it('changes nothing for FK and translate targets, and defaults to IK', () => {
    const w0 = solveWorld(defaultPose());
    const withFlag = resolveDrag(defaultPose(), target('elbowL'), -20, 90, 0, false);
    const without = resolveDrag(defaultPose(), target('elbowL'), -20, 90, 0);
    expect(poseEquals(withFlag, without, 1e-9)).toBe(true);
    // Omitting the flag is IK: the wrist lands ON the target, elbow bends.
    const tx = w0.shoulderL.x - 10;
    const ty = w0.shoulderL.y - 18;
    const ik = resolveDrag(defaultPose(), target('wristL'), tx, ty);
    const w = solveWorld(ik);
    expect(w.wristL.x).toBeCloseTo(tx, 4);
    expect(w.wristL.y).toBeCloseTo(ty, 4);
  });
});

describe('pose serialization', () => {
  it('round-trips through JSON untouched', () => {
    let p = defaultPose();
    p = resolveDrag(p, target('wristR'), 30, 90);
    p = resolveDrag(p, target('spine'), 6, 66);
    const back = sanitizePose(JSON.parse(JSON.stringify(p)));
    expect(poseEquals(back, p, 1e-9)).toBe(true);
  });

  it('shrugs off garbage: junk in, T-pose (or the sane part) out', () => {
    expect(poseEquals(sanitizePose(null), defaultPose())).toBe(true);
    expect(poseEquals(sanitizePose('x'), defaultPose())).toBe(true);
    const partial = sanitizePose({
      rootX: 12, rootY: Infinity,
      angles: { elbowL: 0.5, neck: 3, bogus: 1, elbowR: NaN, wristL: [1, NaN, 0, 0] },
    });
    expect(partial.rootX).toBe(12);
    expect(partial.rootY).toBe(0); // non-finite dropped
    expect(partial.angles.elbowL).toBeDefined();
    // Non-posable, unknown, and non-finite entries never survive.
    expect(partial.angles).not.toHaveProperty('neck');
    expect(partial.angles).not.toHaveProperty('bogus');
    expect(partial.angles).not.toHaveProperty('elbowR');
    expect(partial.angles).not.toHaveProperty('wristL');
  });

  it('loads a v1 PLANAR pose as the identical rotations', () => {
    // The older model stored one angle per bone, about z. A page saved
    // then must re-pose exactly the same figure now.
    const legacy = sanitizePose({ v: 1, rootX: 3, rootY: -2, angles: { elbowL: 1.2, kneeR: -0.4 } });
    const wLegacy = solveWorld(legacy);
    // The same rotations authored natively (a z-rotation IS the view-axis
    // rotation at yaw 0, so an FK drag to the same spot must agree).
    const w0 = solveWorld({ ...defaultPose(), rootX: 3, rootY: -2 });
    const native = resolveDrag(
      { ...defaultPose(), rootX: 3, rootY: -2 }, target('elbowL'),
      w0.shoulderL.x + 13.5 * Math.cos(Math.PI + 1.2), // rest dir π, rotated +1.2
      w0.shoulderL.y + 13.5 * Math.sin(Math.PI + 1.2),
    );
    const wNative = solveWorld(native);
    expect(wLegacy.elbowL.x).toBeCloseTo(wNative.elbowL.x, 5);
    expect(wLegacy.elbowL.y).toBeCloseTo(wNative.elbowL.y, 5);
    expect(wLegacy.elbowL.z).toBeCloseTo(0, 9); // planar stays planar
    // A wound-up legacy angle stores at most one turn.
    const spun = sanitizePose({ angles: { elbowL: Math.PI * 7 } });
    expect(poseEquals(spun, sanitizePose({ angles: { elbowL: normalizeAngle(Math.PI * 7) } }), 1e-9))
      .toBe(true);
  });

  it('elides identity rotations so an untouched joint stores nothing', () => {
    const p = sanitizePose({ angles: { elbowL: 0, kneeL: [0, 0, 0, 1] } });
    expect(Object.keys(p.angles)).toHaveLength(0);
  });
});

// THE interaction rule: every drag rotates about the axis normal to the
// viewport. Head-on that is the rig's own z (the planar behaviour, tested
// above); yawed, it is a different world axis — the elbow's circle of
// movement lies in the VIEW plane, and turning-then-dragging sculpts depth.
describe('view-normal drags (yaw ≠ 0)', () => {
  const YAW = 0.9;

  it('orbits the dragged joint on a CIRCLE in the view plane', () => {
    // T-pose at yaw: the upper arm shows foreshortened. Dragging the elbow
    // must keep that APPARENT radius constant while tracking the finger's
    // angle — the orbit is a circle in the view plane, not the projected
    // ellipse of a rig-plane swing.
    const w0 = solveWorld(defaultPose());
    const sp = projectYaw(w0.shoulderL.x, w0.shoulderL.y, w0.shoulderL.z, YAW, w0.root.x);
    const ep = projectYaw(w0.elbowL.x, w0.elbowL.y, w0.elbowL.z, YAW, w0.root.x);
    const r0 = Math.hypot(ep.px - sp.px, ep.py - sp.py);
    expect(r0).toBeCloseTo(13.5 * Math.cos(YAW), 5); // foreshortened at rest
    for (const ang of [0.4, 1.3, 2.5, -2.0]) {
      const p = resolveDrag(
        defaultPose(), target('elbowL'),
        sp.px + 30 * Math.cos(ang), sp.py + 30 * Math.sin(ang), YAW,
      );
      const w = solveWorld(p);
      const jp = projectYaw(w.elbowL.x, w.elbowL.y, w.elbowL.z, YAW, w.root.x);
      // Constant apparent radius…
      expect(Math.hypot(jp.px - sp.px, jp.py - sp.py)).toBeCloseTo(r0, 5);
      // …at exactly the finger's angle.
      expect(Math.atan2(jp.py - sp.py, jp.px - sp.px)).toBeCloseTo(ang, 5);
      // And the bone's true length never changes.
      expect(Math.hypot(
        w.elbowL.x - w.shoulderL.x, w.elbowL.y - w.shoulderL.y, w.elbowL.z - w.shoulderL.z,
      )).toBeCloseTo(13.5, 6);
    }
  });

  it('turn-then-drag sculpts DEPTH: a yawed head drag leaves the rig plane', () => {
    const w0 = solveWorld(defaultPose());
    const np = projectYaw(w0.neck.x, w0.neck.y, w0.neck.z, YAW, w0.root.x);
    // Pull the head sideways in the yawed view…
    const p = resolveDrag(defaultPose(), target('head'), np.px + 11, np.py + 2, YAW);
    const w = solveWorld(p);
    // …and the head now stands OFF the rig plane: real z, invisible to the
    // old planar model.
    expect(Math.abs(w.head.z)).toBeGreaterThan(2);
    expect(Math.hypot(w.head.x - w.neck.x, w.head.y - w.neck.y, w.head.z - w.neck.z))
      .toBeCloseTo(11.8, 6);
  });

  it('IK reaches across the view plane on APPARENT lengths', () => {
    // At yaw the arm measures shorter on screen; a wrist drag solves with
    // those projected lengths, so the wrist lands under the finger whenever
    // the foreshortened reach allows — and the bones keep their true 3D
    // lengths throughout.
    const w0 = solveWorld(defaultPose());
    const sp = projectYaw(w0.shoulderL.x, w0.shoulderL.y, w0.shoulderL.z, YAW, w0.root.x);
    const reach = (13.5 + 12.5) * Math.cos(YAW);
    const tx = sp.px - reach * 0.5;
    const ty = sp.py - reach * 0.4;
    const p = resolveDrag(defaultPose(), target('wristL'), tx, ty, YAW);
    const w = solveWorld(p);
    const wp = projectYaw(w.wristL.x, w.wristL.y, w.wristL.z, YAW, w.root.x);
    expect(wp.px).toBeCloseTo(tx, 3);
    expect(wp.py).toBeCloseTo(ty, 3);
    expect(Math.hypot(
      w.elbowL.x - w.shoulderL.x, w.elbowL.y - w.shoulderL.y, w.elbowL.z - w.shoulderL.z,
    )).toBeCloseTo(13.5, 5);
    expect(Math.hypot(
      w.wristL.x - w.elbowL.x, w.wristL.y - w.elbowL.y, w.wristL.z - w.elbowL.z,
    )).toBeCloseTo(12.5, 5);
  });

  it('the root tracks the finger exactly at any yaw — it IS the pivot', () => {
    const p = resolveDrag(defaultPose(), target('root'), 17, 40, 2.4);
    const w = solveWorld(p);
    expect(w.root.x).toBeCloseTo(17, 6);
    expect(w.root.y).toBeCloseTo(40, 6);
  });

  it('an edge-on bone refuses the drag instead of spinning wildly', () => {
    // At 90° an in-plane arm projects onto its own shoulder: no apparent
    // radius, no defined angle — the drag must no-op, not explode.
    const w0 = solveWorld(defaultPose());
    const sp = projectYaw(w0.shoulderL.x, w0.shoulderL.y, w0.shoulderL.z, Math.PI / 2, w0.root.x);
    const p = resolveDrag(defaultPose(), target('elbowL'), sp.px + 10, sp.py + 5, Math.PI / 2);
    expect(poseEquals(p, defaultPose())).toBe(true);
  });
});

// A host whose rig object is transformed in ITS scene passes a full Turn:
// the same interaction contract must hold about any rig-plane axis.
describe('drags under a general turn axis', () => {
  const TURN: Turn = { upX: 1, upY: 0, yaw: 0.9 }; // a 90°-rotated host scene
  const q = turnQuat(TURN);
  const proj = (j: { x: number; y: number; z: number }, root: { x: number; y: number }) =>
    projectTurn(j.x, j.y, j.z, q, root.x, root.y);

  it('orbits a dragged joint at constant apparent radius, tracking the finger', () => {
    const w0 = solveWorld(defaultPose());
    const sp = proj(w0.shoulderL, w0.root);
    const ep = proj(w0.elbowL, w0.root);
    const r0 = Math.hypot(ep.px - sp.px, ep.py - sp.py);
    for (const ang of [0.5, 2.1, -1.2]) {
      const p = resolveDrag(
        defaultPose(), target('elbowL'),
        sp.px + 30 * Math.cos(ang), sp.py + 30 * Math.sin(ang), TURN,
      );
      const w = solveWorld(p);
      const jp = proj(w.elbowL, w.root);
      expect(Math.hypot(jp.px - sp.px, jp.py - sp.py)).toBeCloseTo(r0, 5);
      expect(Math.atan2(jp.py - sp.py, jp.px - sp.px)).toBeCloseTo(ang, 5);
      // The shoulder never moves; the bone keeps its true length.
      expect(w.shoulderL.x).toBeCloseTo(w0.shoulderL.x, 6);
      expect(w.shoulderL.y).toBeCloseTo(w0.shoulderL.y, 6);
      expect(Math.hypot(
        w.elbowL.x - w.shoulderL.x, w.elbowL.y - w.shoulderL.y, w.elbowL.z - w.shoulderL.z,
      )).toBeCloseTo(13.5, 6);
    }
  });

  it('IK lands the wrist under the finger in the turned view', () => {
    const w0 = solveWorld(defaultPose());
    const sp = proj(w0.shoulderL, w0.root);
    const tx = sp.px - 14;
    const ty = sp.py - 9;
    const p = resolveDrag(defaultPose(), target('wristL'), tx, ty, TURN);
    const w = solveWorld(p);
    const wp = proj(w.wristL, w.root);
    expect(wp.px).toBeCloseTo(tx, 3);
    expect(wp.py).toBeCloseTo(ty, 3);
    expect(Math.hypot(
      w.wristL.x - w.elbowL.x, w.wristL.y - w.elbowL.y, w.wristL.z - w.elbowL.z,
    )).toBeCloseTo(12.5, 5);
  });

  it('the root still tracks the finger exactly — it IS the pivot', () => {
    const p = resolveDrag(defaultPose(), target('root'), 17, 40, TURN);
    const w = solveWorld(p);
    expect(w.root.x).toBeCloseTo(17, 6);
    expect(w.root.y).toBeCloseTo(40, 6);
  });
});

describe('drag-target coverage', () => {
  it('offers the AnimationMentor control set: hips, spine, chest, head, and both full limbs', () => {
    const joints = DRAG_TARGETS.map((t) => t.joint);
    for (const expected of [
      'root', 'spine', 'chest', 'head',
      'shoulderL', 'elbowL', 'wristL', 'shoulderR', 'elbowR', 'wristR',
      'kneeL', 'ankleL', 'kneeR', 'ankleR',
    ]) {
      expect(joints).toContain(expected);
    }
  });

  it('reaches ends by IK, mid-joints by FK, the root by translation', () => {
    expect(target('root').kind).toBe('translate');
    expect(target('elbowL').kind).toBe('fk');
    expect(target('wristL').kind).toBe('ik2');
    expect(target('ankleR').kind).toBe('ik2');
    // Every IK chain names posable joints that exist.
    for (const t of DRAG_TARGETS) {
      if (t.kind !== 'ik2') continue;
      for (const j of t.chain!) expect(restJoint(j).posable).toBe(true);
    }
  });
});
