/**
 * The one camera: yaw about the up axis as a pure view transform, and the
 * canvas fit. Plus the projected silhouette hosts bake from.
 */

import { defaultPose, resolveDrag, solveWorld } from '../pose';
import { dragTargetFor } from '../skeleton';
import { hitTest, HIT_RADIUS_PX } from '../hit';
import { projectSilhouette } from '../primitives';
import { STAGE, fitStage, projectYaw } from '../view';

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
  const fit = fitStage(400, 700);
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

  it('hit-tests the PROJECTED figure — a yawed shoulder is where it shows', () => {
    const yaw = 1.0;
    const s = screenOf('wristR', yaw);
    const hit = hitTest(defaultPose(), yaw, fit, s.x, s.y);
    expect(hit?.target.joint).toBe('wristR');
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
      const head = flat.findIndex((p) => p.kind === 'ellipse' && !p.tint && p.rx > 9);
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
      const head = flat.find((p) => p.kind === 'ellipse' && !p.tint && p.rx > 9)!;
      expect(head.kind).toBe('ellipse');
      if (head.kind === 'ellipse') {
        expect(head.rx).toBeCloseTo(10.2, 5);
        expect(head.ry).toBeCloseTo(10.2, 5);
      }
    }
  });

  it('narrows the foot wedge as the figure turns edge-on to it', () => {
    const foot = (yaw: number) => projectSilhouette(defaultPose(), yaw)
      .filter((p): p is Extract<typeof p, { kind: 'ellipse' }> => p.kind === 'ellipse')
      .filter((p) => !p.tint && p.cy < 10)
      .map((p) => Math.max(p.rx, p.ry));
    // Head-on, the foot shows its narrow front (long axis is depth);
    // at 90° the full toe length swings into view.
    const headOn = Math.max(...foot(0));
    const side = Math.max(...foot(Math.PI / 2));
    expect(side).toBeGreaterThan(headOn * 1.5);
  });

  it('poses carry into the silhouette — a raised arm shows raised', () => {
    const raised = resolveDrag(defaultPose(), dragTargetFor('elbowL')!, -32, 95);
    const flat = projectSilhouette(raised, 0);
    // Some capsule now tops out above the shoulder line.
    const highArm = flat.some((p) => p.kind === 'capsule' && p.radius < 2 && Math.min(p.ay, p.by) > 80);
    expect(highArm).toBe(true);
  });
});
