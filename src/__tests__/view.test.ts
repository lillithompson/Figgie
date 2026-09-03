/**
 * The one camera: a turn about a rig-plane axis as a pure view transform
 * (yaw about the up axis being the classic case), and the canvas fit.
 * Plus the projected silhouette hosts bake from.
 */

import { defaultPose, resolveDrag, solveWorld, viewAxis } from '../pose';
import { RIG_HEIGHT, dragTargetFor } from '../skeleton';
import { hitTest, HIT_RADIUS_PX } from '../hit';
import { posePrimitives, projectSilhouette } from '../primitives';
import { STAGE, fitStage, projectTurn, projectYaw, turnQuat } from '../view';

describe('projectYaw', () => {
  it('is the identity at yaw 0', () => {
    const p = projectYaw(12, 34, 5, 0, 0);
    expect(p.px).toBeCloseTo(12, 9);
    expect(p.py).toBeCloseTo(34, 9);
    expect(p.pz).toBeCloseTo(5, 9);
  });

  it('swings depth into view at a quarter turn — the feet become visible', () => {
    // A toe at z=+9 sits invisible head-on; at 90° it sticks out sideways.
    const p = projectYaw(0, 6, 9, Math.PI / 2, 0);
    expect(p.px).toBeCloseTo(9, 9);
    expect(p.pz).toBeCloseTo(0, 9);
  });

  it('turns about the figure, not the stage — a moved root stays put', () => {
    const p = projectYaw(20, 50, 0, Math.PI / 3, 20); // point ON the pivot
    expect(p.px).toBeCloseTo(20, 9);
  });

  it('never changes y — there is no way to tumble the rig', () => {
    for (const yaw of [0.3, 1.2, 2.8, -2.1]) {
      expect(projectYaw(7, 42, 3, yaw, 0).py).toBe(42);
    }
  });
});

describe('projectTurn (a general rig-plane turn axis)', () => {
  it('a number turn IS projectYaw — the classic view, unchanged', () => {
    for (const yaw of [0, 0.7, -1.9]) {
      const q = turnQuat(yaw);
      const a = projectTurn(11, 30, 4, q, 3, 60);
      const b = projectYaw(11, 30, 4, yaw, 3);
      expect(a.px).toBeCloseTo(b.px, 9);
      expect(a.py).toBeCloseTo(b.py, 9);
      expect(a.pz).toBeCloseTo(b.pz, 9);
    }
  });

  it('{upX: 0, upY: 1} is the same rotation as the plain scalar', () => {
    const a = projectTurn(7, 80, 5, turnQuat({ upX: 0, upY: 1, yaw: 0.9 }), 2, 50);
    const b = projectYaw(7, 80, 5, 0.9, 2);
    expect(a.px).toBeCloseTo(b.px, 9);
    expect(a.py).toBeCloseTo(b.py, 9);
    expect(a.pz).toBeCloseTo(b.pz, 9);
  });

  it('a sideways axis (1, 0) turns depth into ±y and never touches x', () => {
    // The axis a host derives when its rig object is rotated 90° in a
    // scene: what shows as "up" there is the rig's own x. A point toward
    // the viewer (z > 0) swings along −y (right-hand rule about +x)…
    const q = turnQuat({ upX: 1, upY: 0, yaw: Math.PI / 2 });
    const p = projectTurn(0, 0, 9, q, 0, 0);
    expect(p.px).toBeCloseTo(0, 9);
    expect(p.py).toBeCloseTo(-9, 9);
    expect(p.pz).toBeCloseTo(0, 9);
    // …and a point ON the axis holds still, exactly like the yaw pivot.
    const on = projectTurn(6, 0, 0, q, 0, 0);
    expect(on.px).toBeCloseTo(6, 9);
    expect(on.py).toBeCloseTo(0, 9);
  });

  it('pivots about the point, so a moved root stays put under any axis', () => {
    const q = turnQuat({ upX: 0.6, upY: 0.8, yaw: 1.1 });
    const p = projectTurn(12, -7, 0, q, 12, -7);
    expect(p.px).toBeCloseTo(12, 9);
    expect(p.py).toBeCloseTo(-7, 9);
    expect(p.pz).toBeCloseTo(0, 9);
  });

  it('a degenerate or non-finite turn falls back to the up axis / 0', () => {
    const p = projectTurn(3, 4, 5, turnQuat({ upX: 0, upY: 0, yaw: 0.5 }), 0, 0);
    const b = projectYaw(3, 4, 5, 0.5, 0);
    expect(p.px).toBeCloseTo(b.px, 9);
    const n = projectTurn(3, 4, 5, turnQuat(Number.NaN), 0, 0);
    expect(n.px).toBeCloseTo(3, 9);
    expect(n.pz).toBeCloseTo(5, 9);
  });

  it('viewAxis is the turned view normal — drags rotate about it', () => {
    // Classic yaw: the long-standing (-sin, 0, cos).
    const [ax, ay, az] = viewAxis(0.8);
    expect(ax).toBeCloseTo(-Math.sin(0.8), 9);
    expect(ay).toBeCloseTo(0, 9);
    expect(az).toBeCloseTo(Math.cos(0.8), 9);
    // Sideways axis: the normal tilts through y instead of x.
    const [bx, by, bz] = viewAxis({ upX: 1, upY: 0, yaw: 0.8 });
    expect(bx).toBeCloseTo(0, 9);
    expect(by).toBeCloseTo(Math.sin(0.8), 9);
    expect(bz).toBeCloseTo(Math.cos(0.8), 9);
  });
});

describe('fitStage', () => {
  it('contains the whole stage at every aspect, centered', () => {
    for (const [w, h] of [[300, 600], [800, 400], [500, 500]] as const) {
      const fit = fitStage(w, h);
      const sw = (STAGE.maxX - STAGE.minX) * fit.scale;
      const sh = (STAGE.maxY - STAGE.minY) * fit.scale;
      expect(sw).toBeLessThanOrEqual(w + 1e-6);
      expect(sh).toBeLessThanOrEqual(h + 1e-6);
      // Center of stage lands on center of canvas.
      expect(fit.toScreenX((STAGE.minX + STAGE.maxX) / 2)).toBeCloseTo(w / 2, 6);
      expect(fit.toScreenY((STAGE.minY + STAGE.maxY) / 2)).toBeCloseTo(h / 2, 6);
    }
  });

  it('round-trips screen ↔ view, with y flipped (rig is y-up)', () => {
    const fit = fitStage(414, 700);
    expect(fit.toViewX(fit.toScreenX(17))).toBeCloseTo(17, 6);
    expect(fit.toViewY(fit.toScreenY(80))).toBeCloseTo(80, 6);
    // Higher rig y = smaller screen y.
    expect(fit.toScreenY(90)).toBeLessThan(fit.toScreenY(10));
  });
});

describe('hitTest', () => {
  // A host's canvas COVERS the whole stage (that is how RigNodeLayer sizes
  // it), so what a thumb-sized capture radius is measured against is how
  // big the FIGURE is drawn — px per rig unit — and not the canvas's own
  // dimensions. Sizing the fit off the stage pins that: change the stage
  // and the canvas changes with it, exactly as a host's does, leaving a
  // rig this size on the page reading the same.
  const FIGURE_PX = 277; // a phone-sized mannequin, RIG_HEIGHT tall
  const px = FIGURE_PX / RIG_HEIGHT;
  const fit = fitStage((STAGE.maxX - STAGE.minX) * px, (STAGE.maxY - STAGE.minY) * px);
  const screenOf = (joint: string, yaw = 0) => {
    const w = solveWorld(defaultPose());
    const j = w[joint as keyof typeof w];
    const p = projectYaw(j.x, j.y, j.z, yaw, w.root.x);
    return { x: fit.toScreenX(p.px), y: fit.toScreenY(p.py) };
  };

  it('grabs the joint under the finger', () => {
    const s = screenOf('elbowL');
    const hit = hitTest(defaultPose(), 0, fit, s.x + 4, s.y - 3);
    expect(hit?.target.joint).toBe('elbowL');
    // The grab remembers the finger's offset from the joint (in view
    // units), so the drag moves by deltas instead of snapping the joint
    // under the tip.
    expect(Math.hypot(hit!.grabDx, hit!.grabDy) * fit.scale).toBeCloseTo(5, 0);
  });

  it('prefers the nearest of two close targets', () => {
    // Between wrist and elbow, nearer the wrist.
    const wrist = screenOf('wristL');
    const elbow = screenOf('elbowL');
    const x = wrist.x * 0.7 + elbow.x * 0.3;
    const y = wrist.y;
    const hit = hitTest(defaultPose(), 0, fit, x, y);
    expect(hit?.target.joint).toBe('wristL');
  });

  it('returns null in open space, leaving the press to the host', () => {
    expect(hitTest(defaultPose(), 0, fit, 8, 8)).toBeNull();
  });

  it('leaves the HIPS to the host — a rig is grabbed by its joints', () => {
    // The root used to wear the biggest knob on the figure, right in the
    // middle of it, so the commonest press on a rig picked the whole thing
    // up instead of posing it. Nothing answers there now; the press falls
    // through to the host, where dragging the object moves it like any
    // other object in the scene.
    const hips = screenOf('root');
    for (const fine of [false, true]) {
      const hit = hitTest(defaultPose(), 0, fit, hips.x, hips.y, fine);
      // Whatever it lands on is a joint to POSE — never the figure itself.
      expect(hit?.target.joint).not.toBe('root');
      expect(hit?.target.kind).not.toBe('translate');
    }
    // Here it is the spine just above, so a press on the hips still does
    // the posing thing rather than nothing at all.
    expect(hitTest(defaultPose(), 0, fit, hips.x, hips.y)?.target.joint).toBe('spine');
  });

  it('hit-tests the PROJECTED figure — a yawed shoulder is where it shows', () => {
    const yaw = 1.0;
    const s = screenOf('wristR', yaw);
    const hit = hitTest(defaultPose(), yaw, fit, s.x, s.y);
    expect(hit?.target.joint).toBe('wristR');
  });

  it('offers hand joints only through the fine gate', () => {
    // Without `fine`, a press on the hand can only ever mean the WRIST: a
    // press on the knuckle line inside the wrist's capture grabs the
    // wrist, and one out at the fingertip (past that capture) grabs
    // nothing at all.
    const base = screenOf('middleL0');
    expect(hitTest(defaultPose(), 0, fit, base.x, base.y)?.target.joint).toBe('wristL');
    const tip = screenOf('middleL3');
    expect(hitTest(defaultPose(), 0, fit, tip.x, tip.y)).toBeNull();
    // The gate opens the hand's own joints to the same presses — at the
    // knuckle line that is the palm-bend effector, at the tip the finger.
    expect(hitTest(defaultPose(), 0, fit, base.x, base.y, true)?.target.joint)
      .toBe('knuckL');
    expect(hitTest(defaultPose(), 0, fit, tip.x, tip.y, true)?.target.joint).toBe('middleL3');
  });

  it('grabs every corner of the L one from another once the gate opens', () => {
    // The foot's four joints, each pressed dead on: with the gate open
    // every one answers for itself — the two inside the foot are grabbable,
    // and grabbing one does not disturb the rest.
    const pose = defaultPose();
    for (const joint of ['ankleL', 'heelL', 'ballL', 'toeL'] as const) {
      const s = screenOf(joint);
      expect(hitTest(pose, 0, fit, s.x, s.y, true)?.target.joint).toBe(joint);
    }
    // And each does its own thing: the ankle carries the leg (IK up the
    // chain), the heel pitches the whole foot about the ankle, the ball
    // lifts the foot's front off the heel, the toe bends the foot in two.
    expect(dragTargetFor('ankleL')!.kind).toBe('ik2');
    expect(dragTargetFor('heelL')!.kind).toBe('fk');
    expect(dragTargetFor('ballL')!.kind).toBe('fk');
    expect(dragTargetFor('toeL')!.kind).toBe('ik2');
  });

  it('keeps the HEEL behind the gate — it sits right under the ankle', () => {
    // The L's upright is the shortest bone in the figure, so face-on the
    // heel projects a couple of rig units below the ankle, inside its
    // knob. Offered at that size it would only steal the ankle's presses.
    const s = screenOf('heelL');
    const joint = hitTest(defaultPose(), 0, fit, s.x, s.y)?.target.joint;
    expect(joint).not.toBe('heelL');
    expect(['ankleL', 'toeL', 'ballL']).toContain(joint);
    // Zoomed in, it answers for itself.
    expect(hitTest(defaultPose(), 0, fit, s.x, s.y, true)?.target.joint).toBe('heelL');
  });

  it('grabs the BALL from any distance, like the toe beside it', () => {
    // Lifting the front of the foot is an everyday pose — flat, tiptoe, or
    // rolling between them — so it cannot be the one bend that costs a
    // zoom first while the toe next to it answers at any size.
    const s = screenOf('ballL');
    expect(hitTest(defaultPose(), 0, fit, s.x, s.y)?.target.joint).toBe('ballL');
    expect(hitTest(defaultPose(), 0, fit, s.x, s.y, true)?.target.joint).toBe('ballL');
    // …and it bends the foot at the ball rather than carrying the leg.
    expect(hitTest(defaultPose(), 0, fit, s.x, s.y)?.target.kind).toBe('fk');
  });

  it('draws no knob inside the foot, as for the fingers', () => {
    const knobs = posePrimitives(defaultPose()).filter((p) => p.kind === 'knob');
    const joints = knobs.map((k) => (k as { joint: string }).joint);
    expect(joints).toContain('ankleL');
    expect(joints).toContain('toeL');
    expect(joints).not.toContain('heelL');
    // The ball is grabbable at any size but still beadless: a third knob
    // between the ankle's and the toe's would merge with both.
    expect(joints).not.toContain('ballL');
  });

  it('captures within a thumb radius and no further', () => {
    const s = screenOf('head');
    const near = hitTest(defaultPose(), 0, fit, s.x + HIT_RADIUS_PX - 2, s.y);
    expect(near?.target.joint).toBe('head');
    const far = hitTest(defaultPose(), 0, fit, s.x + HIT_RADIUS_PX * 3, s.y - HIT_RADIUS_PX * 3);
    expect(far?.target.joint ?? null).not.toBe('head');
  });
});

describe('projectSilhouette (the bake hosts draw from)', () => {
  it('is depth-sorted back to front', () => {
    const flat = projectSilhouette(defaultPose(), 0.7);
    for (let i = 1; i < flat.length; i++) {
      expect(flat[i].depth).toBeGreaterThanOrEqual(flat[i - 1].depth);
    }
  });

  it('keeps eyes in front of the head facing forward, behind it turned away', () => {
    const order = (yaw: number) => {
      const flat = projectSilhouette(defaultPose(), yaw);
      const eye = flat.findIndex((p) => p.kind === 'ellipse' && p.tint === 'eye');
      // The head is the biggest untinted ball (8.67; the torso masses stop
      // at 6.8).
      const head = flat.findIndex((p) => p.kind === 'ellipse' && !p.tint && p.rx > 7);
      return { eye, head };
    };
    const front = order(0);
    expect(front.eye).toBeGreaterThan(front.head);
    const back = order(Math.PI);
    expect(back.eye).toBeLessThan(back.head);
  });

  it('projects spheres to circles of the same radius at any yaw', () => {
    for (const yaw of [0, 0.8, 2.2]) {
      const flat = projectSilhouette(defaultPose(), yaw);
      const head = flat.find((p) => p.kind === 'ellipse' && !p.tint && p.rx > 7)!;
      expect(head.kind).toBe('ellipse');
      if (head.kind === 'ellipse') {
        expect(head.rx).toBeCloseTo(8.67, 5);
        expect(head.ry).toBeCloseTo(8.67, 5);
      }
    }
  });

  it('foreshortens the foot bones as the figure turns', () => {
    // The foot chain points mostly at the viewer (splayed a little), so
    // head-on its capsules project short; at 90° their full length swings
    // into view.
    const footReach = (yaw: number) => Math.max(...projectSilhouette(defaultPose(), yaw)
      .filter((p): p is Extract<typeof p, { kind: 'capsule' }> =>
        p.kind === 'capsule' && Math.max(p.ay, p.by) < 8)
      .map((p) => Math.hypot(p.bx - p.ax, p.by - p.ay)));
    expect(footReach(Math.PI / 2)).toBeGreaterThan(footReach(0) * 1.4);
  });

  it('poses carry into the silhouette — a raised arm shows raised', () => {
    const raised = resolveDrag(defaultPose(), dragTargetFor('elbowL')!, -32, 95);
    const flat = projectSilhouette(raised, 0);
    // Some capsule now tops out above the shoulder line.
    const highArm = flat.some((p) => p.kind === 'capsule' && p.radius < 2 && Math.min(p.ay, p.by) > 80);
    expect(highArm).toBe(true);
  });
});
