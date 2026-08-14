/**
 * The posture shapers a host drives from one slider each: curl a hand into
 * a fist, point or flatten a foot, bend / twist / lean the spine. All are
 * ABSOLUTE (idempotent), disjoint in the joints they own, and leave a pose
 * untouched at rest.
 */

import {
  FINGER_COLUMN, FIST_RANGE, SPINE_COLUMN, SPINE_RANGE, curlHand, flexFoot, shapeSpine, centered,
} from '../shape';
import { defaultPose, poseEquals, resolveDrag, solveWorld } from '../pose';
import { quatRotate } from '../quat';
import { JointId, dragTargetFor } from '../skeleton';

describe('curlHand', () => {
  it('is flat at 0 and a closed fist at 1', () => {
    const flat = curlHand(defaultPose(), 'L', 0);
    expect(poseEquals(flat, defaultPose())).toBe(true);
    const w0 = solveWorld(defaultPose());
    const w = solveWorld(curlHand(defaultPose(), 'L', 1));
    // Every fingertip folds back toward the wrist…
    for (const name of ['index', 'middle', 'ring', 'pinky']) {
      const tip = w[`${name}L3` as keyof typeof w];
      const tip0 = w0[`${name}L3` as keyof typeof w];
      const reach = Math.hypot(tip.x - w.wristL.x, tip.y - w.wristL.y);
      const reach0 = Math.hypot(tip0.x - w0.wristL.x, tip0.y - w0.wristL.y);
      expect(reach).toBeLessThan(reach0 * 0.6);
    }
    // …swinging OUT of the palm's plane on the way, toward the face the
    // hand holds up — not sideways across it. Half-curled, every tip
    // stands clear in depth while keeping its height. (A tight fist wraps
    // back down to the palm, which is why the arc is checked mid-way.)
    const half = solveWorld(curlHand(defaultPose(), 'L', 0.5));
    for (const name of ['index', 'middle', 'ring', 'pinky']) {
      const tip = half[`${name}L3` as keyof typeof half];
      const tip0 = w0[`${name}L3` as keyof typeof w0];
      expect(tip.z).toBeGreaterThan(tip0.z + 3);
      expect(tip.y).toBeCloseTo(tip0.y, 6); // the fan's spread is the hinge
    }
  });

  it('curls both hands INTO the palm — mirrored, not parallel', () => {
    const w0 = solveWorld(defaultPose());
    const l = solveWorld(curlHand(defaultPose(), 'L', 1));
    const r = solveWorld(curlHand(defaultPose(), 'R', 1));
    // Each fingertip folds back to its own palm…
    expect(Math.hypot(l.middleL3.x - l.wristL.x, l.middleL3.y - l.wristL.y)).toBeLessThan(6);
    expect(Math.hypot(r.middleR3.x - r.wristR.x, r.middleR3.y - r.wristR.y)).toBeLessThan(6);
    // …and the two are mirror images about the figure's center line,
    // curling the SAME way in depth (both toward the palm's face).
    expect(l.middleL3.x - w0.wristL.x).toBeCloseTo(-(r.middleR3.x - w0.wristR.x), 6);
    expect(l.middleL3.y).toBeCloseTo(r.middleR3.y, 6);
    expect(l.middleL3.z).toBeCloseTo(r.middleR3.z, 6);
  });

  it('shares the curl across every joint in the finger', () => {
    const p = curlHand(defaultPose(), 'L', 1);
    const angleOf = (id: string) => 2 * Math.acos(Math.min(1, Math.abs(
      (p.angles[id as keyof typeof p.angles] as [number, number, number, number])[3],
    )));
    expect(FINGER_COLUMN.map(([, share]) => share).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    const segs = FINGER_COLUMN.map(([seg]) => angleOf(`middleL${seg}`));
    // Every knuckle bends, none of them dominating — a finger that arcs
    // rather than one that stays straight and folds at a single joint.
    for (const a of segs) expect(a).toBeGreaterThan(0.7);
    expect(Math.max(...segs)).toBeLessThan(Math.min(...segs) * 1.4);
    expect(segs.reduce((a, b) => a + b, 0)).toBeCloseTo(FIST_RANGE.finger, 5);
    // The base knuckle stays rigid: it is where the finger meets the palm.
    expect(p.angles.middleL0).toBeUndefined();
  });

  it('is absolute: dragging the slider never compounds', () => {
    const once = curlHand(defaultPose(), 'L', 0.6);
    const again = curlHand(curlHand(curlHand(defaultPose(), 'L', 0.2), 'L', 0.9), 'L', 0.6);
    expect(poseEquals(again, once)).toBe(true);
  });

  it('touches ONE hand, leaving the other and the body alone', () => {
    const posed = resolveDrag(defaultPose(), dragTargetFor('elbowL')!, -30, 92);
    const curled = curlHand(posed, 'R', 1);
    const w0 = solveWorld(posed);
    const w = solveWorld(curled);
    expect(w.elbowL.x).toBeCloseTo(w0.elbowL.x, 9);
    expect(w.middleL3.x).toBeCloseTo(w0.middleL3.x, 9);
    expect(w.head.y).toBeCloseTo(w0.head.y, 9);
    for (const id of Object.keys(curled.angles)) {
      expect(id.endsWith('L') || /L\d$/.test(id)).toBe(id.includes('elbowL'));
    }
  });
});

describe('flexFoot', () => {
  it('is flat (the rest foot) at 1 and pointed at 0', () => {
    expect(poseEquals(flexFoot(defaultPose(), 'L', 1), defaultPose())).toBe(true);
    const w0 = solveWorld(defaultPose());
    const w = solveWorld(flexFoot(defaultPose(), 'L', 0));
    // A pointed toe drops below the rest sole and reaches further out.
    expect(w.toeL.y).toBeLessThan(w0.toeL.y - 2);
    expect(w.ankleL.y).toBeCloseTo(w0.ankleL.y, 9); // the ankle holds
  });

  it('points down its own splayed line, not sideways', () => {
    // The foot's horizontal heading is unchanged by the pitch — only its
    // height drops — so a pointed foot still faces where it stood.
    const w0 = solveWorld(defaultPose());
    const w = solveWorld(flexFoot(defaultPose(), 'L', 0));
    const heading = (a: { x: number; z: number }, b: { x: number; z: number }) =>
      Math.atan2(b.z - a.z, b.x - a.x);
    expect(heading(w.ankleL, w.toeL)).toBeCloseTo(heading(w0.ankleL, w0.toeL), 2);
  });

  it('is absolute, and touches ONE foot', () => {
    const once = flexFoot(defaultPose(), 'R', 0.3);
    expect(poseEquals(flexFoot(flexFoot(defaultPose(), 'R', 1), 'R', 0.3), once)).toBe(true);
    expect(Object.keys(once.angles).sort()).toEqual(['ballR', 'toeR']);
  });
});

describe('shapeSpine', () => {
  const straight = { bend: 0, twist: 0, lean: 0 };

  it('is exactly straight at center — the pose is untouched', () => {
    const posed = resolveDrag(defaultPose(), dragTargetFor('elbowL')!, -30, 92);
    expect(shapeSpine(posed, straight)).toEqual(posed);
    expect(centered(0.5)).toBe(0);
  });

  it('bends forward and back about the side axis', () => {
    const w0 = solveWorld(defaultPose());
    const fwd = solveWorld(shapeSpine(defaultPose(), { ...straight, bend: 1 }));
    const back = solveWorld(shapeSpine(defaultPose(), { ...straight, bend: -1 }));
    expect(fwd.head.z).toBeGreaterThan(w0.head.z + 4);
    expect(back.head.z).toBeLessThan(w0.head.z - 4);
    // A bend, not a lean: the head stays over the center line.
    expect(fwd.head.x).toBeCloseTo(w0.head.x, 6);
  });

  it('twists the shoulders about the up axis', () => {
    const w0 = solveWorld(defaultPose());
    const t = solveWorld(shapeSpine(defaultPose(), { ...straight, twist: 1 }));
    // One shoulder comes toward the viewer, the other goes away…
    expect(t.shoulderL.z).toBeGreaterThan(w0.shoulderL.z + 2);
    expect(t.shoulderR.z).toBeLessThan(w0.shoulderR.z - 2);
    // …and the head stays upright over the root.
    expect(t.head.y).toBeGreaterThan(w0.head.y - 1);
  });

  it('leans sideways, opposite ways at the two ends of the slider', () => {
    const w0 = solveWorld(defaultPose());
    const l = solveWorld(shapeSpine(defaultPose(), { ...straight, lean: -1 }));
    const r = solveWorld(shapeSpine(defaultPose(), { ...straight, lean: 1 }));
    expect(l.head.x).toBeLessThan(w0.head.x - 4);
    expect(r.head.x).toBeGreaterThan(w0.head.x + 4);
  });

  it('shares the curve along the whole column, stomach to head', () => {
    const p = shapeSpine(defaultPose(), { ...straight, bend: 1 });
    // Every bone from the pelvis up takes some of it — the stomach, the
    // chest, the shoulder girdle, and on through the neck to the head.
    expect(Object.keys(p.angles).sort())
      .toEqual(['chest', 'collar', 'head', 'neck', 'spine']);
    expect(SPINE_COLUMN.map(([, share]) => share).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    // …weighted toward the base, so the arc is smooth rather than a hinge.
    const angleOf = (id: JointId) =>
      2 * Math.acos(Math.min(1, Math.abs(p.angles[id]![3])));
    const column = SPINE_COLUMN.map(([id]) => angleOf(id));
    for (let i = 1; i < column.length; i++) {
      expect(column[i - 1]).toBeGreaterThan(column[i]);
    }
    // The total is the full range the slider promises.
    expect(column.reduce((a, b) => a + b, 0)).toBeCloseTo(SPINE_RANGE.bend, 6);
  });

  it('bends far enough to fold the figure right over', () => {
    // The range is the point of spreading it: a bend this deep would be a
    // broken hinge at one joint, and reads as a stoop across five.
    expect(SPINE_RANGE.bend).toBeGreaterThan(Math.PI / 2);
    const w0 = solveWorld(defaultPose());
    const w = solveWorld(shapeSpine(defaultPose(), { ...straight, bend: 1 }));
    // The head ends up out in FRONT of the hips and down near them, not
    // still up in the air.
    expect(w.head.z).toBeGreaterThan(w0.head.z + 20);
    expect(w.head.y).toBeLessThan(w0.root.y + 20);
    // …and the shoulders came round with it.
    expect(w.shoulderL.z).toBeGreaterThan(w0.shoulderL.z + 10);
  });

  it('turns the head with the curve, so the figure looks where it bends', () => {
    // The head is the last link in the column: with a deep bend it faces
    // the floor rather than staring level out of a folded body.
    const straightHead = solveWorld(defaultPose());
    const w = solveWorld(shapeSpine(defaultPose(), { ...straight, bend: 1 }));
    const gaze = (world: typeof w) => {
      const [, , dz] = quatRotate(world.head.rot, 0, 0, 1);
      return dz;
    };
    expect(gaze(w)).toBeLessThan(gaze(straightHead));
  });

  it('is absolute, and the three sliders compose to one posture', () => {
    const shape = { bend: 0.4, twist: -0.6, lean: 0.2 };
    const once = shapeSpine(defaultPose(), shape);
    const wandered = shapeSpine(shapeSpine(defaultPose(), { bend: -1, twist: 1, lean: -1 }), shape);
    expect(poseEquals(wandered, once)).toBe(true);
  });

  it('leaves the limbs alone — only the column moves', () => {
    const posed = curlHand(defaultPose(), 'L', 1);
    const shaped = shapeSpine(posed, { bend: 0.5, twist: 0, lean: 0 });
    for (const id of Object.keys(posed.angles)) {
      expect(shaped.angles[id as keyof typeof shaped.angles]).toEqual(
        posed.angles[id as keyof typeof posed.angles],
      );
    }
  });
});
