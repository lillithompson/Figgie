/**
 * The posture shapers a host drives from one slider each: curl a hand into
 * a fist, point or flatten a foot, bend / twist / lean the spine, nod or
 * shake the head. All are ABSOLUTE (idempotent), disjoint in the joints
 * they own — bar the head and the spine, which share a column and so ADD
 * rather than overwrite — and leave a pose untouched at rest.
 */

import {
  FINGER_COLUMN, FIST_RANGE, HEAD_COLUMN, HEAD_RANGE, SPINE_COLUMN, SPINE_RANGE, curlHand,
  bendWrist, flexFoot, rotateRig, shapeHead, shapeSpine, centered, spreadHand, twistAnkle,
  twistWrist,
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
    expect(Object.keys(once.angles).sort()).toEqual(['heelR', 'toeR']);
  });

  it('pitches the whole foot about the ankle, leaving the ball alone', () => {
    // The slider swings the L's upright, so the sole tips as one piece and
    // the heel rides back and up — standing on tiptoe. The ball is the
    // player's to bend; pointing the foot must not overwrite it.
    const w0 = solveWorld(defaultPose());
    const w = solveWorld(flexFoot(defaultPose(), 'L', 0));
    expect(w.heelL.y).toBeGreaterThan(w0.heelL.y + 1);
    expect(w.heelL.z).toBeLessThan(w0.heelL.z);
    // Sole flat at rest, steep when pointed — measured heel to toe.
    const pitch = (s: typeof w0) => Math.atan2(
      s.heelL.y - s.toeL.y,
      Math.hypot(s.toeL.x - s.heelL.x, s.toeL.z - s.heelL.z),
    );
    expect(Math.abs(pitch(w0))).toBeLessThan(0.1);
    expect(pitch(w)).toBeGreaterThan(0.8);
    // …and the foot keeps its own length through the pitch: a rotation,
    // never a stretch.
    const span = (s: typeof w0) => Math.hypot(
      s.ballL.x - s.heelL.x, s.ballL.y - s.heelL.y, s.ballL.z - s.heelL.z,
    );
    expect(span(w)).toBeCloseTo(span(w0), 6);
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

  it('is absolute about the pose it is HANDED, off any base', () => {
    // One base and one triple make one posture however the sliders got
    // there: a host feeding the same base re-derives, never compounds.
    const shape = { bend: 0.4, twist: -0.6, lean: 0.2 };
    for (const base of [defaultPose(), curlHand(defaultPose(), 'R', 1)]) {
      expect(poseEquals(shapeSpine(base, shape), shapeSpine(base, shape))).toBe(true);
    }
    // And off a STRAIGHT base it is the posture it always was — the fixed
    // lean-then-bend-then-twist composition, nothing else touched.
    expect(Object.keys(shapeSpine(defaultPose(), shape).angles).sort())
      .toEqual(SPINE_COLUMN.map(([id]) => id).sort());
  });

  it('keeps a bend the pose already had, and leans it side to side', () => {
    // The bug this fixes: the column was written over from the sliders, so
    // a spine already bent — by hand, or loaded from a saved page, where
    // slider positions do not survive — sprang straight the moment any
    // slider moved. Each slider owns its own dimension and leaves the rest.
    const bent = shapeSpine(defaultPose(), { ...straight, bend: 1 });
    const posed = solveWorld(bent);
    // Sliders back at rest, LEAN alone moved: the head goes sideways…
    const leaned = solveWorld(shapeSpine(bent, { ...straight, lean: 1 }));
    expect(Math.abs(leaned.head.x - posed.head.x)).toBeGreaterThan(2);
    // …and the figure is still folded over, not stood back up.
    expect(leaned.head.z).toBeGreaterThan(posed.head.z * 0.8);
    expect(leaned.head.y).toBeLessThan(posed.head.y + 4);
    // Centre every slider and the pose is left exactly as it was.
    expect(poseEquals(shapeSpine(bent, straight), bent)).toBe(true);
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

describe('shapeHead', () => {
  const level = { nod: 0, shake: 0 };
  /** Which way the face points, in the world. */
  const gaze = (pose: ReturnType<typeof defaultPose>) => {
    const [dx, dy, dz] = quatRotate(solveWorld(pose).head.rot, 0, 0, 1);
    return { dx, dy, dz };
  };

  it('is exactly level at center — the pose is untouched', () => {
    const posed = shapeSpine(curlHand(defaultPose(), 'R', 1), { bend: 0.4, twist: 0, lean: 0 });
    expect(poseEquals(shapeHead(posed, level), posed)).toBe(true);
    expect(shapeHead(defaultPose(), level).angles).toEqual({});
  });

  it('nods the face down and back up', () => {
    const down = gaze(shapeHead(defaultPose(), { ...level, nod: 1 }));
    const up = gaze(shapeHead(defaultPose(), { ...level, nod: -1 }));
    const straight = gaze(defaultPose());
    expect(down.dy).toBeLessThan(straight.dy - 0.5);   // chin toward the chest
    expect(up.dy).toBeGreaterThan(straight.dy + 0.5);  // and the face to the sky
    // A nod, not a shake: the face stays on the center line either way.
    expect(down.dx).toBeCloseTo(0, 6);
    expect(up.dx).toBeCloseTo(0, 6);
  });

  it('shakes the face side to side, the way the slider reads', () => {
    // Screen right is +x (view.ts maps px straight through), and the spine's
    // own Twist turns that way for a positive value — the head has to agree
    // with it or the two bars would disagree about which end is "right".
    const right = gaze(shapeHead(defaultPose(), { ...level, shake: 1 }));
    const left = gaze(shapeHead(defaultPose(), { ...level, shake: -1 }));
    expect(right.dx).toBeGreaterThan(0.5);
    expect(left.dx).toBeLessThan(-0.5);
    // …and the face stays level while it turns.
    expect(right.dy).toBeCloseTo(0, 6);
  });

  it('tilts the ear toward the shoulder — the axis nod and shake leave over', () => {
    // A roll about the gaze: the head's own UP leans while the face keeps
    // pointing exactly where it was.
    const up = (pose: ReturnType<typeof defaultPose>) =>
      quatRotate(solveWorld(pose).head.rot, 0, 1, 0);
    const [rightX] = up(shapeHead(defaultPose(), { ...level, tilt: 1 }));
    const [leftX] = up(shapeHead(defaultPose(), { ...level, tilt: -1 }));
    expect(rightX * leftX).toBeLessThan(0);           // opposite shoulders
    expect(Math.abs(rightX)).toBeGreaterThan(0.4);    // a real lay-over
    const g = gaze(shapeHead(defaultPose(), { ...level, tilt: 1 }));
    expect(g.dx).toBeCloseTo(0, 6);
    expect(g.dy).toBeCloseTo(0, 6);
    // …and untouched, the axis is exactly absent from the pose.
    expect(shapeHead(defaultPose(), { ...level, tilt: 0 }).angles).toEqual({});
  });

  it('turns the head ALONE — the shoulders and the spine stay put', () => {
    // What separates it from the Spine bar, whose bend carries the whole
    // column round and takes the head along at the end of it.
    const w0 = solveWorld(defaultPose());
    const w = solveWorld(shapeHead(defaultPose(), { nod: 1, shake: 1 }));
    expect(w.shoulderL.x).toBeCloseTo(w0.shoulderL.x, 6);
    expect(w.shoulderL.z).toBeCloseTo(w0.shoulderL.z, 6);
    expect(w.chest.y).toBeCloseTo(w0.chest.y, 6);
    expect(Object.keys(shapeHead(defaultPose(), { nod: 1, shake: 1 }).angles).sort())
      .toEqual(['head', 'neck']);
  });

  it('shares the turn so the neck carries the ball, not just the face', () => {
    // All of a nod on `head` would roll the eyes inside a ball that never
    // moved. The neck's share swings the ball itself around on its riser,
    // which is what a nod actually looks like.
    const w0 = solveWorld(defaultPose());
    const nodded = shapeHead(defaultPose(), { ...level, nod: 1 });
    expect(solveWorld(nodded).head.z).toBeGreaterThan(w0.head.z + 1);
    expect(HEAD_COLUMN.map(([, share]) => share).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    const angleOf = (id: JointId) =>
      2 * Math.acos(Math.min(1, Math.abs(nodded.angles[id]![3])));
    expect(angleOf('head')).toBeGreaterThan(angleOf('neck'));
    // The total is the full range the slider promises.
    expect(angleOf('head') + angleOf('neck')).toBeCloseTo(HEAD_RANGE.nod, 6);
  });

  it('adds to a head the spine already turned, instead of straightening it', () => {
    // The two bars write the SAME joints, so the head's sliders must leave a
    // stoop where it stood — the bug the spine's own sliders had.
    const stooped = shapeSpine(defaultPose(), { bend: 1, twist: 0, lean: 0 });
    const before = solveWorld(stooped);
    const after = solveWorld(shapeHead(stooped, { ...level, nod: -1 }));
    // Still folded over: the body below the neck has not moved at all, and
    // the head is still out in front of it (the ball rides back a little on
    // its riser, which is the neck's own share of the nod).
    expect(after.shoulderL.z).toBeCloseTo(before.shoulderL.z, 6);
    expect(after.chest.z).toBeCloseTo(before.chest.z, 6);
    expect(after.head.z).toBeGreaterThan(before.head.z * 0.8);
    // …but the face has come up out of it. Measured on the FORWARD component:
    // a stoop this deep has the head past straight down, where the vertical
    // one flattens out and stops telling the two apart.
    expect(gaze(shapeHead(stooped, { ...level, nod: -1 })).dz)
      .toBeGreaterThan(gaze(stooped).dz + 0.5);
    expect(gaze(shapeHead(stooped, { ...level, nod: -1 })).dy)
      .toBeGreaterThan(gaze(stooped).dy);
    expect(poseEquals(shapeHead(stooped, level), stooped)).toBe(true);
  });

  it('is absolute about the pose it is HANDED, off any base', () => {
    const shape = { nod: 0.4, shake: -0.6 };
    for (const base of [defaultPose(), curlHand(defaultPose(), 'R', 1)]) {
      expect(poseEquals(shapeHead(base, shape), shapeHead(base, shape))).toBe(true);
    }
  });
});

describe('rotateRig', () => {
  const still = { x: 0, y: 0, z: 0 };

  it('leaves the pose exactly as it found it at rest', () => {
    const posed = shapeSpine(curlHand(defaultPose(), 'L', 0.6), { bend: 0.3, twist: 0, lean: 0 });
    expect(poseEquals(rotateRig(posed, still), posed)).toBe(true);
    expect(rotateRig(defaultPose(), still).angles).toEqual({});
  });

  it('turns the WHOLE figure, pose intact underneath', () => {
    const w0 = solveWorld(defaultPose());
    // A half turn about the up axis swaps left and right on screen…
    const w = solveWorld(rotateRig(defaultPose(), { ...still, y: 1 }));
    expect(w.wristL.x).toBeCloseTo(-w0.wristL.x, 6);
    expect(w.head.y).toBeCloseTo(w0.head.y, 6);
    // …and the joint that was 42 out to the left is still 42 from the root.
    const reach = (a: typeof w0, id: 'wristL') =>
      Math.hypot(a[id].x - a.root.x, a[id].y - a.root.y, a[id].z - a.root.z);
    expect(reach(w, 'wristL')).toBeCloseTo(reach(w0, 'wristL'), 6);
  });

  it('tips forward on x and sideways on z', () => {
    const w0 = solveWorld(defaultPose());
    const pitched = solveWorld(rotateRig(defaultPose(), { ...still, x: 0.5 }));
    expect(pitched.head.z).toBeGreaterThan(w0.head.z + 10); // face-first toward the viewer
    const rolled = solveWorld(rotateRig(defaultPose(), { ...still, z: 0.5 }));
    expect(rolled.head.x).not.toBeCloseTo(w0.head.x, 1);
    expect(rolled.head.y).toBeLessThan(w0.head.y);
  });

  it('is absolute, and owns exactly one joint', () => {
    const spin = { x: 0.3, y: -0.7, z: 0.1 };
    const once = rotateRig(defaultPose(), spin);
    const wandered = rotateRig(rotateRig(defaultPose(), { x: -1, y: 1, z: -1 }), spin);
    expect(poseEquals(wandered, once)).toBe(true);
    expect(Object.keys(once.angles)).toEqual(['root']);
  });

  it('composes with the other shapers rather than fighting them', () => {
    // Disjoint joint sets: a spun figure keeps its fists and its curve.
    const posed = curlHand(shapeSpine(defaultPose(), { bend: 0.5, twist: 0, lean: 0 }), 'R', 1);
    const spun = rotateRig(posed, { x: 0, y: 0.5, z: 0 });
    for (const id of Object.keys(posed.angles)) {
      expect(spun.angles[id as keyof typeof spun.angles]).toEqual(posed.angles[id as keyof typeof posed.angles]);
    }
  });
});

describe('spreadHand', () => {
  const dist2 = (a: { x: number; y: number }, b: typeof a) => Math.hypot(a.x - b.x, a.y - b.y);

  it('leaves the fan alone at centre, opens it wide at +1, squeezes at −1', () => {
    expect(poseEquals(spreadHand(defaultPose(), 'L', 0), defaultPose())).toBe(true);
    const w0 = solveWorld(defaultPose());
    const wide = solveWorld(spreadHand(defaultPose(), 'L', 1));
    const tight = solveWorld(spreadHand(defaultPose(), 'L', -1));
    // The fan's width is the thumb-to-pinky gap at the tips.
    const span = (w: typeof w0) => dist2(w.thumbL3, w.pinkyL3);
    expect(span(wide)).toBeGreaterThan(span(w0) + 2);
    expect(span(tight)).toBeLessThan(span(w0) - 2);
  });

  it('spreads both hands in mirror', () => {
    const l = solveWorld(spreadHand(defaultPose(), 'L', 1));
    const r = solveWorld(spreadHand(defaultPose(), 'R', 1));
    expect(dist2(l.thumbL3, l.pinkyL3)).toBeCloseTo(dist2(r.thumbR3, r.pinkyR3), 6);
  });

  it('composes with the curl instead of overwriting it — a spread fist stays a fist', () => {
    // Both shapers write the finger base segments; the spread is a twist
    // about the palm normal and the curl a swing about the knuckle line,
    // so each survives the other in either order.
    const fist = curlHand(defaultPose(), 'L', 1);
    const spreadFist = spreadHand(fist, 'L', 1);
    const w = solveWorld(spreadFist);
    const wf = solveWorld(fist);
    // Still a fist: the middle tip stays folded back near the wrist.
    expect(dist2(w.middleL3, w.wristL)).toBeLessThan(dist2(wf.middleL3, wf.wristL) + 1);
    // …and the spread survives a re-curl at the same value (idempotent
    // shapers re-derive rather than compound), in EITHER order — the curl
    // writes its own twist component of the shared joints, not the whole
    // rotation.
    expect(poseEquals(spreadHand(spreadFist, 'L', 1), spreadFist)).toBe(true);
    expect(poseEquals(curlHand(spreadFist, 'L', 1), spreadFist)).toBe(true);
    // Back to centre restores the plain fist exactly.
    expect(poseEquals(spreadHand(spreadFist, 'L', 0), fist)).toBe(true);
  });

  it('writes only its own hand’s finger bases', () => {
    const posed = spreadHand(defaultPose(), 'L', 0.8);
    const touched = Object.keys(posed.angles).sort();
    expect(touched).toEqual(['indexL1', 'middleL1', 'pinkyL1', 'ringL1', 'thumbL1']);
  });
});

describe('bendWrist', () => {
  const dist = (a: { x: number; y: number; z: number }, b: typeof a) =>
    Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

  it('is straight at centre and folds the whole hand either way off it', () => {
    expect(poseEquals(bendWrist(defaultPose(), 'L', 0), defaultPose())).toBe(true);
    const w0 = solveWorld(defaultPose());
    const back = solveWorld(bendWrist(defaultPose(), 'L', 1));
    const fwd = solveWorld(bendWrist(defaultPose(), 'L', -1));
    // The wrist itself has not budged — the forearm is untouched, the hand
    // hinges on the end of it…
    expect(dist(back.wristL, w0.wristL)).toBeCloseTo(0, 9);
    // …and the whole hand goes: fingertips AND the thumb, which rides the
    // inner palm and so sits out a knuckle-line bend entirely.
    for (const id of ['middleL3', 'pinkyL3', 'thumbL3', 'knuckL'] as const) {
      expect(dist(back[id], w0[id])).toBeGreaterThan(1);
      expect(dist(fwd[id], w0[id])).toBeGreaterThan(1);
    }
    // Back and forward are opposite ways off straight, out of the palm's
    // plane (the flex axis is the knuckle line, so the travel is in z).
    expect(Math.sign(back.middleL3.z - w0.middleL3.z))
      .toBe(-Math.sign(fwd.middleL3.z - w0.middleL3.z));
  });

  it('bends both hands the same way in the world', () => {
    const l = solveWorld(bendWrist(defaultPose(), 'L', 1));
    const r = solveWorld(bendWrist(defaultPose(), 'R', 1));
    const w0 = solveWorld(defaultPose());
    expect(l.middleL3.z - w0.middleL3.z).toBeCloseTo(r.middleR3.z - w0.middleR3.z, 6);
  });

  it('writes only its own hand’s hinge, and is absolute', () => {
    const posed = bendWrist(defaultPose(), 'L', 0.7);
    expect(Object.keys(posed.angles)).toEqual(['palmL']);
    // Re-deriving at the same value repeats rather than compounds; at
    // centre it undoes itself exactly.
    expect(poseEquals(bendWrist(posed, 'L', 0.7), posed)).toBe(true);
    expect(poseEquals(bendWrist(posed, 'L', 0), defaultPose())).toBe(true);
  });

  it('is disjoint from the curl, the twist and the spread', () => {
    // Four sliders, four sets of joints: a bent hand can still make a
    // fist, and none of the four disturbs another.
    const bent = bendWrist(defaultPose(), 'L', 1);
    const fist = curlHand(bent, 'L', 1);
    expect(fist.angles.palmL).toEqual(bent.angles.palmL);
    const rolled = twistWrist(fist, 'L', 1);
    const splayed = spreadHand(rolled, 'L', 1);
    expect(splayed.angles.palmL).toEqual(bent.angles.palmL);
    expect(poseEquals(bendWrist(splayed, 'L', 1), splayed)).toBe(true);
  });
});

describe('twistWrist / twistAnkle', () => {
  const dist = (a: { x: number; y: number; z: number }, b: typeof a) =>
    Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

  it('leaves the pose alone at centre, and rolls the hand off it', () => {
    expect(poseEquals(twistWrist(defaultPose(), 'L', 0), defaultPose())).toBe(true);
    const w0 = solveWorld(defaultPose());
    const w = solveWorld(twistWrist(defaultPose(), 'L', 1));
    // The wrist itself has not budged — a roll turns the hand in place…
    expect(dist(w.wristL, w0.wristL)).toBeCloseTo(0, 9);
    expect(dist(w.elbowL, w0.elbowL)).toBeCloseTo(0, 9);
    // …but the hand swings round it, and keeps its reach doing so. Read at
    // the THUMB: the other fingers reach straight down the forearm's line,
    // which is the axis itself, and barely move however far it rolls.
    expect(dist(w.thumbL3, w0.thumbL3)).toBeGreaterThan(2);
    expect(dist(w.thumbL3, w.wristL)).toBeCloseTo(dist(w0.thumbL3, w0.wristL), 6);
  });

  it('swivels the foot about the shin without moving the ankle', () => {
    expect(poseEquals(twistAnkle(defaultPose(), 'R', 0), defaultPose())).toBe(true);
    const w0 = solveWorld(defaultPose());
    const w = solveWorld(twistAnkle(defaultPose(), 'R', 1));
    expect(dist(w.ankleR, w0.ankleR)).toBeCloseTo(0, 9);
    expect(dist(w.toeR, w0.toeR)).toBeGreaterThan(1);
    // A swivel about the vertical shin: the toe circles at its own height.
    expect(w.toeR.y).toBeCloseTo(w0.toeR.y, 6);
  });

  it('turns the two sides in mirror, not in convoy', () => {
    // One sign of the slider means the same thing on both sides — hands
    // rolling the same way as each other, toes both turning outward.
    const w0 = solveWorld(defaultPose());
    for (const [f, joint] of [[twistWrist, 'thumbL3'], [twistAnkle, 'toeL']] as const) {
      const mirror = joint.replace('L', 'R') as JointId;
      const l = solveWorld(f(defaultPose(), 'L', 1));
      const r = solveWorld(f(defaultPose(), 'R', 1));
      expect(l[joint].x - w0[joint].x).toBeCloseTo(-(r[mirror].x - w0[mirror].x), 6);
      expect(l[joint].z - w0[joint].z).toBeCloseTo(r[mirror].z - w0[mirror].z, 6);
    }
  });

  it('is absolute, and keeps the reach a drag posed', () => {
    // The wrist is where an arm's IK lands, so a twist must not undo it:
    // the hand rolls, the wrist stays exactly where the drag left it, and
    // twisting twice running gives the identical pose.
    const w0 = solveWorld(defaultPose());
    const reached = resolveDrag(
      defaultPose(), dragTargetFor('wristL')!, w0.shoulderL.x - 6, w0.shoulderL.y - 14,
    );
    const posed = solveWorld(reached);
    const once = twistWrist(reached, 'L', 0.6);
    expect(poseEquals(twistWrist(once, 'L', 0.6), once)).toBe(true);
    const w = solveWorld(once);
    expect(dist(w.wristL, posed.wristL)).toBeCloseTo(0, 6);
    expect(dist(w.elbowL, posed.elbowL)).toBeCloseTo(0, 6);
    // Back to centre and the arm is left as the drag made it.
    expect(poseEquals(twistWrist(once, 'L', 0), reached)).toBe(true);
  });

  it('touches ONE joint per side, and none the other shapers own', () => {
    const hand = twistWrist(twistAnkle(defaultPose(), 'R', 0.5), 'L', 0.5);
    expect(Object.keys(hand.angles).sort()).toEqual(['ankleR', 'wristL']);
    // Curl and flex still own their own joints, so a part's sliders stack.
    const both = flexFoot(twistAnkle(defaultPose(), 'L', 0.5), 'L', 0);
    expect(Object.keys(both.angles).sort()).toEqual(['ankleL', 'heelL', 'toeL']);
  });
});
