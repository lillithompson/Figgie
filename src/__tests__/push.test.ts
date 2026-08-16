/**
 * The push brush: the one gesture that MOVES joints instead of rotating
 * bones. What is under the circle travels with the finger, what is at its
 * rim does not, and whatever it smears stays inside the stage.
 */

import { FiggiePose, defaultPose, poseEquals, sanitizePose, solveWorld } from '../pose';
import { PUSH_FALLOFF_K, pushFalloff, pushPose } from '../push';
import {
  JOINT_IDS, MAX_REACH, PUSH_ROOM, SKELETON, STAGE_REACH, assemblyMembers, assemblyOf,
  jointBound, restJoint,
} from '../skeleton';
import { STAGE, projectTurn, turnQuat } from '../view';
import { quatFromAxisAngle } from '../quat';
import { curlHand } from '../shape';

/** Where a joint SHOWS under `turn` — the plane the brush is defined in. */
function shown(pose: FiggiePose, id: string, turn: number | { upX: number; upY: number; yaw: number } = 0) {
  const world = solveWorld(pose);
  const j = world[id as never] as { x: number; y: number; z: number };
  const q = turnQuat(turn);
  return projectTurn(j.x, j.y, j.z, q, world.root.x, world.root.y);
}

describe('the falloff', () => {
  it('is full force at the centre and exactly nothing at the rim', () => {
    // The two ends the brush is specified by: most force in the middle, 0
    // motion at the very edge of the circle.
    expect(pushFalloff(0)).toBe(1);
    expect(pushFalloff(1)).toBe(0);
    expect(pushFalloff(1.4)).toBe(0);
    expect(pushFalloff(-0.2)).toBe(1); // a joint dead under the centre
  });

  it('is a gaussian bell, falling all the way — never a truncated step', () => {
    let prev = 1;
    for (let t = 0.05; t <= 1; t += 0.05) {
      const w = pushFalloff(t);
      expect(w).toBeLessThan(prev);
      prev = w;
    }
    // Shifted so the rim really is zero, then renormalized: the shape is
    // still exp(-K t²) up to that affine correction.
    const rim = Math.exp(-PUSH_FALLOFF_K);
    expect(pushFalloff(0.5)).toBeCloseTo((Math.exp(-PUSH_FALLOFF_K * 0.25) - rim) / (1 - rim), 12);
  });
});

describe('one dab', () => {
  it('moves the joint under the centre by the full finger travel', () => {
    const at = shown(defaultPose(), 'wristL');
    const pushed = pushPose(defaultPose(), 0, at.px, at.py, 3, -2, 8);
    const after = shown(pushed, 'wristL');
    expect(after.px - at.px).toBeCloseTo(3, 6);
    expect(after.py - at.py).toBeCloseTo(-2, 6);
  });

  it('leaves everything outside the circle exactly where it was', () => {
    // A tight brush on one wrist: the elbow it hangs off is well clear of
    // the rim, so the forearm STRETCHES rather than swinging — that is the
    // deformation rotations cannot express.
    const rest = defaultPose();
    const at = shown(rest, 'wristL');
    const pushed = pushPose(rest, 0, at.px, at.py, 0, 5, 4);
    const before = solveWorld(rest);
    const after = solveWorld(pushed);
    expect(after.wristL.y).toBeCloseTo(before.wristL.y + 5, 6);
    expect(after.elbowL.y).toBeCloseTo(before.elbowL.y, 6);
    expect(after.shoulderL.y).toBeCloseTo(before.shoulderL.y, 6);
    expect(after.root.y).toBeCloseTo(before.root.y, 6);
  });

  it('tapers UPSTREAM: a parent halfway out moves less than the joint at the centre', () => {
    // The taper shapes the transition out of the still body — the shoulder
    // near the rim bending the upper arm smoothly where the elbow at the
    // middle travels the whole way.
    const rest = defaultPose();
    const w = solveWorld(rest);
    const span = Math.hypot(w.shoulderL.x - w.elbowL.x, w.shoulderL.y - w.elbowL.y);
    const at = shown(rest, 'elbowL');
    const pushed = pushPose(rest, 0, at.px, at.py, 0, 4, span * 2);
    const after = solveWorld(pushed);
    const elbow = after.elbowL.y - w.elbowL.y;
    const shoulder = after.shoulderL.y - w.shoulderL.y;
    expect(elbow).toBeCloseTo(4, 6);
    expect(shoulder).toBeGreaterThan(0);
    expect(shoulder).toBeLessThan(elbow);
    expect(shoulder).toBeCloseTo(4 * pushFalloff(span / (span * 2)), 6);
  });

  it('never moves the root — the anchor the view pivots on', () => {
    const rest = defaultPose();
    const at = shown(rest, 'root');
    const pushed = pushPose(rest, 0, at.px, at.py, 6, 6, 30);
    expect(pushed.offsets?.root).toBeUndefined();
    expect(solveWorld(pushed).root.x).toBeCloseTo(solveWorld(rest).root.x, 12);
  });

  it('accumulates: a run of dabs is one long stroke', () => {
    // A stroke is a run of dabs, each carrying the travel since the last
    // move — the brush riding along under the finger, so a joint kept in
    // the middle of it travels the whole way.
    const rest = defaultPose();
    let pose = rest;
    for (let i = 0; i < 4; i++) {
      const at = shown(pose, 'head');
      pose = pushPose(pose, 0, at.px, at.py, 1, 0, 12);
    }
    expect(solveWorld(pose).head.x - solveWorld(rest).head.x).toBeCloseTo(4, 6);
  });

  it('is inert when the finger has not travelled, or the circle is empty', () => {
    const rest = defaultPose();
    expect(pushPose(rest, 0, 0, 0, 0, 0, 8)).toBe(rest);
    expect(pushPose(rest, 0, 400, 400, 3, 3, 8)).toBe(rest); // miles off the figure
    expect(pushPose(rest, 0, 0, 0, 3, 3, 0)).toBe(rest); // no brush at all
  });
});

describe('nothing is left behind', () => {
  it('what hangs off a shoved joint comes with it, whole', () => {
    // Brush on the knee: the thigh LENGTHENS (the hip barely moves) while
    // the shin and the whole foot ride down rigidly. Without the parent's
    // share as a floor, the foot would lag behind the ankle that carries
    // it — and the flesh hung on those joints has nothing else to follow.
    const rest = defaultPose();
    const w = solveWorld(rest);
    const at = shown(rest, 'kneeL');
    const pushed = pushPose(rest, 0, at.px, at.py, 0, -6, 8);
    const after = solveWorld(pushed);
    expect(after.kneeL.y - w.kneeL.y).toBeCloseTo(-6, 6);
    for (const id of ['ankleL', 'heelL', 'ballL', 'toeL'] as const) {
      expect(after[id].y - w[id].y).toBeCloseTo(-6, 6);
    }
    // …and the thigh is longer for it, hip left where it was.
    expect(after.hipL.y).toBeCloseTo(w.hipL.y, 6);
    expect(after.kneeL.y - after.hipL.y).toBeLessThan(w.kneeL.y - w.hipL.y);
  });

  it('a hand goes with its wrist, fingers and all', () => {
    const rest = defaultPose();
    const w = solveWorld(rest);
    const at = shown(rest, 'wristL');
    const after = solveWorld(pushPose(rest, 0, at.px, at.py, -5, 0, 3));
    for (const id of ['wristL', 'palmL', 'knuckL', 'middleL3', 'thumbL2'] as const) {
      expect(after[id].x - w[id].x).toBeCloseTo(-5, 6);
    }
  });

  it('is continuous at the rim — riding the parent is what weight zero means', () => {
    // A joint just inside the circle and one just outside it must move
    // alike, or the figure would tear along the brush's own edge.
    const rest = defaultPose();
    const w = solveWorld(rest);
    const at = shown(rest, 'elbowL');
    const span = Math.hypot(w.wristL.x - w.elbowL.x, w.wristL.y - w.elbowL.y);
    const inside = solveWorld(pushPose(rest, 0, at.px, at.py, 0, 3, span * 1.001));
    const outside = solveWorld(pushPose(rest, 0, at.px, at.py, 0, 3, span * 0.999));
    expect(inside.wristL.y - w.wristL.y).toBeCloseTo(outside.wristL.y - w.wristL.y, 6);
  });

  it('the root still takes nothing, and hands nothing down', () => {
    // A brush grazing the pelvis must not drag the whole figure by way of
    // the root — every joint moves on its own falloff there.
    const rest = defaultPose();
    const w = solveWorld(rest);
    const at = shown(rest, 'root');
    const after = solveWorld(pushPose(rest, 0, at.px, at.py, 4, 0, 12));
    expect(after.root.x).toBeCloseTo(w.root.x, 12);
    expect(after.head.x - w.head.x).toBeLessThan(4 - 1e-6); // tapered, not carried
  });
});

describe('the turned view', () => {
  it('pushes in the direction the VIEWER sees, whatever the figure faces', () => {
    // Quarter-turned, the figure's +z faces the viewer's right, so a shove
    // to the right of the SCREEN pushes the joint toward the viewer in rig
    // space: the brush is defined in the view plane exactly as a joint drag
    // is, which is what makes flat strokes build depth.
    const turn = Math.PI / 2;
    const rest = defaultPose();
    const at = shown(rest, 'wristL', turn);
    const pushed = pushPose(rest, turn, at.px, at.py, 4, 0, 8);
    const after = shown(pushed, 'wristL', turn);
    expect(after.px - at.px).toBeCloseTo(4, 6);
    const w = solveWorld(pushed);
    const before = solveWorld(rest);
    expect(w.wristL.z - before.wristL.z).toBeCloseTo(4, 6);
    expect(w.wristL.x).toBeCloseTo(before.wristL.x, 6);
  });
});

/**
 * The brush is a DEFORMER: a stroke across a hand or a foot moves each
 * joint by what it is under, so fingers bend and soles stretch. Only the
 * few pairs with no drawn bone between them travel as one (GLUED_PAIRS).
 */
describe('the brush smears a hand and a foot', () => {
  const PLATE_L = ['wristL', 'palmL', 'thumbL0'] as const;
  const KNUCKLE_L = ['knuckL', 'indexL0', 'middleL0', 'ringL0', 'pinkyL0'] as const;
  const FOOT_L = ['ankleL', 'heelL', 'ballL', 'toeL'] as const;

  /** Every joint's displacement between two poses. */
  const shift = (before: FiggiePose, after: FiggiePose, ids: readonly string[]) => {
    const a = solveWorld(before);
    const b = solveWorld(after);
    return ids.map((id) => {
      const p = a[id as never] as { x: number; y: number; z: number };
      const q = b[id as never] as { x: number; y: number; z: number };
      return [q.x - p.x, q.y - p.y, q.z - p.z];
    });
  };

  /** How far apart two joints are, to see whether a piece held together. */
  const spanOf = (pose: FiggiePose, a: string, b: string) => {
    const w = solveWorld(pose);
    const p = w[a as never] as { x: number; y: number; z: number };
    const q = w[b as never] as { x: number; y: number; z: number };
    return Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
  };

  /** How far `a` travelled RELATIVE to `b` — the smear itself. Zero for two
   *  joints of one rigid piece, whatever the brush did to the pair. */
  const smear = (before: FiggiePose, after: FiggiePose, a: string, b: string) => {
    const [da, db] = shift(before, after, [a, b]);
    return Math.hypot(da[0] - db[0], da[1] - db[1], da[2] - db[2]);
  };

  it('holds together only what has no bone between it — the palm plate', () => {
    // A finger's rigid base sits INSIDE the palm solid with nothing drawn
    // back to the knuckle line, and the palm's own pin sits behind the
    // wrist's circle: those pairs are one piece. Everything else in the
    // figure spans two joints and is free to stretch.
    expect(assemblyOf('palmL')).toBe('wristL');
    expect(assemblyOf('thumbL0')).toBe('wristL');
    expect(assemblyOf('middleL0')).toBe('knuckL');
    expect(assemblyMembers('wristL')).toEqual([...PLATE_L]);
    expect(assemblyMembers('knuckL')).toEqual([...KNUCKLE_L]);
    // The articulated finger segments are drawn as bones, so they smear.
    expect(assemblyOf('middleL3')).toBeUndefined();
    expect(assemblyOf('thumbL1')).toBeUndefined();
    // So is every joint of the foot — its two solids are skinned across
    // the joints they span now (ink.ts), so the sole stretches.
    for (const id of FOOT_L) expect(assemblyOf(id)).toBeUndefined();
    expect(assemblyOf('elbowL')).toBeUndefined();
    expect(assemblyOf('root')).toBeUndefined();
  });

  it('bends a finger: a brush on the tip leaves the knuckle behind', () => {
    // The whole point of a deformer, and what the hand could not do while
    // it travelled as one piece. The brush is small — a fraction of a
    // finger — and nothing has to be zoomed in for it: what separates one
    // joint from the next is the brush's own size.
    const rest = defaultPose();
    const at = shown(rest, 'middleL3');
    const pushed = pushPose(rest, 0, at.px, at.py, 0, 4, 3);
    const [tip, mid, base, knuck, wrist] =
      shift(rest, pushed, ['middleL3', 'middleL2', 'middleL0', 'knuckL', 'wristL'])
        .map(([, dy]) => dy);
    expect(tip).toBeCloseTo(4, 6);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(tip);       // the finger BENT
    expect(base).toBeLessThan(mid);
    expect(knuck).toBeLessThan(mid);
    expect(wrist).toBeLessThan(1);       // the hand stayed where it was
    // …and the tip really did travel out from under its own knuckle —
    // that is where the deformation went, into bones drawn between joints.
    expect(smear(rest, pushed, 'middleL3', 'middleL0')).toBeGreaterThan(2);
  });

  it('stretches a sole: a brush on the toe leaves the heel behind', () => {
    const rest = defaultPose();
    const at = shown(rest, 'toeL');
    const pushed = pushPose(rest, 0, at.px, at.py, 3, 0, 3);
    const [toe, ball, heel, ankle] =
      shift(rest, pushed, ['toeL', 'ballL', 'heelL', 'ankleL']).map(([dx]) => dx);
    expect(toe).toBeCloseTo(3, 6);
    expect(ball).toBeLessThan(toe);
    expect(heel).toBeLessThan(ball);
    expect(ankle).toBeLessThan(0.5);
    // The sole is one skinned solid across these joints (ink.ts), so it
    // stretches with them instead of leaving the heel behind.
    expect(smear(rest, pushed, 'toeL', 'heelL')).toBeGreaterThan(1.5);
  });

  it('carries the plate whole when the brush catches a finger base', () => {
    // The tear that started all this, in the one place it can still
    // happen: a base knuckle has nothing drawn back to the knuckle line,
    // so a brush tight enough to catch one and not the other has to move
    // both. Each plate takes the strongest share anywhere in it.
    const rest = defaultPose();
    const at = shown(rest, 'middleL0');
    const pushed = pushPose(rest, 0, at.px, at.py, 0, 3, 1.2);
    for (const [, dy] of shift(rest, pushed, KNUCKLE_L)) expect(dy).toBeCloseTo(3, 6);
    for (const group of [PLATE_L, KNUCKLE_L]) {
      for (const a of group) {
        for (const b of group) {
          expect(spanOf(pushed, a, b)).toBeCloseTo(spanOf(rest, a, b), 9);
        }
      }
    }
  });

  it('answers at the end of an extended limb, where posing has already reached', () => {
    // The reported deadness: a raised arm puts its fingertip at the far
    // end of the longest chain in the figure, and with the stage sized to
    // exactly that reach there was nothing left to push into. Every
    // direction moved it by nothing.
    const raised: FiggiePose = {
      ...defaultPose(),
      angles: { shoulderL: quatFromAxisAngle(0, 0, 1, -Math.PI / 2) },
    };
    const w = solveWorld(raised);
    // The arm really is extended: the tip is past what the skeleton alone
    // reaches, less the flesh drawn on it.
    const tip = Math.hypot(
      w.middleL3.x - w.root.x, w.middleL3.y - w.root.y, w.middleL3.z - w.root.z,
    );
    expect(tip).toBeGreaterThan(MAX_REACH - jointBound('middleL3') - 2);
    const at = shown(raised, 'middleL3');
    for (const [dx, dy] of [[0, 6], [6, 0], [0, -6], [-4, 4]] as const) {
      const after = solveWorld(pushPose(raised, 0, at.px, at.py, dx, dy, 10));
      expect(after.middleL3.x - w.middleL3.x).toBeCloseTo(dx, 6);
      expect(after.middleL3.y - w.middleL3.y).toBeCloseTo(dy, 6);
    }
  });

  it('slides along the stage rather than stopping dead against it', () => {
    // Push a foot until it is out of room, then keep pushing: a joint that
    // stopped dead at the boundary read as a brush that had simply
    // switched off. It never stops answering the finger.
    const rest = defaultPose();
    let pose = rest;
    let dabs = 0;
    for (let i = 0; i < 60; i++) {
      const at = shown(pose, 'toeL');
      const next = pushPose(pose, 0, at.px, at.py, -3, -3, 12);
      if (next === pose) break; // froze — the bug
      pose = next;
      dabs += 1;
    }
    expect(dabs).toBe(60);
    const before = solveWorld(rest);
    const after = solveWorld(pose);
    // It travelled far past the room a straight shove had…
    expect(Math.hypot(
      after.toeL.x - before.toeL.x, after.toeL.y - before.toeL.y,
    )).toBeGreaterThan(PUSH_ROOM);
    // …and stayed inside the stage.
    for (const id of FOOT_L) {
      expect(Math.hypot(
        after[id].x - after.root.x, after[id].y - after.root.y, after[id].z - after.root.z,
      ) + jointBound(id)).toBeLessThanOrEqual(STAGE_REACH + 1e-6);
    }
  });

  it('keeps a plate whole even when the shove runs out of stage', () => {
    // The other half of the tear: the clamp is per joint, and the joints
    // of one plate run out of room at slightly different moments. Clamped
    // one at a time, a hard push pulled the palm apart against the stage;
    // one travel for the whole plate cannot.
    const rest = defaultPose();
    const at = shown(rest, 'wristL');
    let pose = rest;
    for (let i = 0; i < 40; i++) pose = pushPose(pose, 0, at.px, at.py, -20, 20, 10);
    const before = solveWorld(rest);
    const after = solveWorld(pose);
    // It moved a long way…
    expect(Math.hypot(
      after.wristL.x - before.wristL.x, after.wristL.y - before.wristL.y,
    )).toBeGreaterThan(5);
    // …and every distance inside each plate is what it was at rest.
    for (const group of [PLATE_L, KNUCKLE_L]) {
      for (const a of group) {
        for (const b of group) {
          expect(spanOf(pose, a, b)).toBeCloseTo(spanOf(rest, a, b), 9);
        }
      }
    }
  });

  it('still lets the hand be posed afterwards', () => {
    // Only DISPLACEMENT is held rigid — the joints keep their own angles,
    // so a pushed hand still curls.
    const rest = defaultPose();
    const at = shown(rest, 'wristL');
    const pushed = pushPose(rest, 0, at.px, at.py, 0, 5, 6);
    const curled = curlHand(pushed, 'L', 1);
    const straight = solveWorld(pushed);
    const bent = solveWorld(curled);
    // The fingertip curls in…
    expect(Math.hypot(
      bent.middleL3.x - straight.middleL3.x, bent.middleL3.y - straight.middleL3.y,
    )).toBeGreaterThan(1);
    // …from a wrist that is still where the brush left it.
    expect(bent.wristL.y).toBeCloseTo(straight.wristL.y, 9);
  });
});

describe('the deformation rides the limb', () => {
  it('swings with the bone when the pose changes later', () => {
    // Offsets are written in the joint's own posed frame, so a hand pushed
    // out and THEN swung stays displaced along the arm rather than
    // pointing off where the arm used to be.
    const rest = defaultPose();
    const at = shown(rest, 'wristL');
    const pushed = pushPose(rest, 0, at.px, at.py, 0, 6, 4);
    const off = pushed.offsets!.wristL!;
    expect(Math.hypot(off[0], off[1], off[2])).toBeCloseTo(6, 6);
    // Turn the forearm a quarter turn about z; the displacement turns too.
    const swung: FiggiePose = {
      ...pushed,
      angles: { ...pushed.angles, wristL: quatFromAxisAngle(0, 0, 1, Math.PI / 2) },
    };
    const base: FiggiePose = { ...rest, angles: { wristL: quatFromAxisAngle(0, 0, 1, Math.PI / 2) } };
    const moved = solveWorld(swung).wristL;
    const plain = solveWorld(base).wristL;
    expect(moved.x - plain.x).toBeCloseTo(-6, 6);
    expect(moved.y - plain.y).toBeCloseTo(0, 6);
  });
});

describe('the stage still frames it', () => {
  it('clamps a hard shove so the figure is never smeared out of its viewport', () => {
    // The promise the whole viewport rests on, now under a tool that can
    // put a joint anywhere: push a wrist as far as the arm will go and
    // every drawn point is still inside the stage, under every turn.
    let pose = defaultPose();
    const at = shown(pose, 'wristL');
    for (let i = 0; i < 40; i++) pose = pushPose(pose, 0, at.px, at.py, -20, 20, 10);
    for (const turn of [0, 0.8, -2.6, Math.PI]) {
      const world = solveWorld(pose);
      const q = turnQuat(turn);
      for (const id of JOINT_IDS) {
        const j = world[id];
        const p = projectTurn(j.x, j.y, j.z, q, world.root.x, world.root.y);
        const b = jointBound(id);
        expect(p.px - b).toBeGreaterThanOrEqual(STAGE.minX - 1e-6);
        expect(p.px + b).toBeLessThanOrEqual(STAGE.maxX + 1e-6);
        expect(p.py - b).toBeGreaterThanOrEqual(STAGE.minY - 1e-6);
        expect(p.py + b).toBeLessThanOrEqual(STAGE.maxY + 1e-6);
      }
    }
  });

  it('leaves less room when the figure has already been walked off centre', () => {
    const rest = restJoint('root');
    const walked: FiggiePose = { ...defaultPose(), rootX: 12 };
    const at = shown(walked, 'wristL');
    let pose = walked;
    for (let i = 0; i < 40; i++) pose = pushPose(pose, 0, at.px, at.py, -20, 0, 10);
    const world = solveWorld(pose);
    const far = Math.hypot(world.wristL.x - world.root.x, world.wristL.y - world.root.y);
    expect(far + jointBound('wristL')).toBeLessThanOrEqual(STAGE_REACH - 12 + 1e-6);
    expect(rest.dx).toBe(0); // the walk really is the offset, not the rest
  });
});

describe('serialization', () => {
  it('round-trips displacements through JSON', () => {
    const rest = defaultPose();
    const at = shown(rest, 'kneeL');
    const pushed = pushPose(rest, 0, at.px, at.py, 2, -3, 9);
    const back = sanitizePose(JSON.parse(JSON.stringify(pushed)));
    expect(poseEquals(back, pushed)).toBe(true);
    expect(solveWorld(back).kneeL.x).toBeCloseTo(solveWorld(pushed).kneeL.x, 9);
  });

  it('reads a displacement on any joint, posable or not', () => {
    // Being pushed is not being posed: a fingertip that no slider can
    // rotate can still be shoved.
    const unposable = SKELETON.find((j) => !j.posable && j.parent)!;
    const back = sanitizePose({ v: 2, rootX: 0, rootY: 0, angles: {}, offsets: { [unposable.id]: [1, 2, 3] } });
    expect(back.offsets?.[unposable.id]).toEqual([1, 2, 3]);
  });

  it('drops junk, zeroes and unknown joints', () => {
    const back = sanitizePose({
      v: 2,
      rootX: 0,
      rootY: 0,
      angles: {},
      offsets: { wristL: [0, 0, 0], elbowL: [1, 'x', null], nose: [1, 1, 1], kneeL: 'nope' },
    });
    expect(back.offsets?.wristL).toBeUndefined();
    expect(back.offsets?.elbowL).toEqual([1, 0, 0]);
    expect((back.offsets as Record<string, unknown>).nose).toBeUndefined();
    expect(back.offsets?.kneeL).toBeUndefined();
  });

  it('leaves an undeformed pose exactly as it always was', () => {
    // Every pose ever saved has no such field, and one pushed back to
    // nothing must look the same again.
    expect(defaultPose().offsets).toBeUndefined();
    expect(JSON.parse(JSON.stringify(sanitizePose(defaultPose()))).offsets).toBeUndefined();
  });

  it('counts as a different figure — a pushed rig has been posed', () => {
    const at = shown(defaultPose(), 'head');
    const pushed = pushPose(defaultPose(), 0, at.px, at.py, 0, 3, 6);
    expect(poseEquals(pushed, defaultPose())).toBe(false);
  });
});
