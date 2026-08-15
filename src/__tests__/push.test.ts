/**
 * The push brush: the one gesture that MOVES joints instead of rotating
 * bones. What is under the circle travels with the finger, what is at its
 * rim does not, and whatever it smears stays inside the stage.
 */

import { FiggiePose, defaultPose, poseEquals, sanitizePose, solveWorld } from '../pose';
import { PUSH_FALLOFF_K, pushFalloff, pushPose } from '../push';
import { JOINT_IDS, MAX_REACH, SKELETON, jointBound, restJoint } from '../skeleton';
import { STAGE, projectTurn, turnQuat } from '../view';
import { quatFromAxisAngle } from '../quat';

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

  it('tapers between the two: a joint halfway out moves less than the centre', () => {
    const rest = defaultPose();
    const w = solveWorld(rest);
    // Brush centred on the elbow, wide enough that the wrist is inside it.
    const span = Math.hypot(w.wristL.x - w.elbowL.x, w.wristL.y - w.elbowL.y);
    const at = shown(rest, 'elbowL');
    const pushed = pushPose(rest, 0, at.px, at.py, 0, 4, span * 2);
    const after = solveWorld(pushed);
    const elbow = after.elbowL.y - w.elbowL.y;
    const wrist = after.wristL.y - w.wristL.y;
    expect(elbow).toBeCloseTo(4, 6);
    expect(wrist).toBeGreaterThan(0);
    expect(wrist).toBeLessThan(elbow);
    expect(wrist).toBeCloseTo(4 * pushFalloff(span / (span * 2)), 6);
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
    expect(far + jointBound('wristL')).toBeLessThanOrEqual(MAX_REACH - 12 + 1e-6);
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
