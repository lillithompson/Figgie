/**
 * The ink sketch: a hand-drawn construction figure as pure 2D geometry —
 * tapered, wobbling pen strokes; the chest, pelvis, palms and feet as
 * solid silhouette-traced volumes; circles at the limb joints; fingers
 * drawn through their posed chains; and a face cross that curves on the
 * head ball and hides when the head turns away.
 */

import { buildInkDraw, inkBatch, inkVector, sketchFills, sketchInk } from '../ink';
import { FiggiePose, defaultPose, resolveDrag, solveWorld } from '../pose';
import { quatFromAxisAngle } from '../quat';
import { dragTargetFor } from '../skeleton';
import { projectYaw } from '../view';

const byId = (strokes: ReturnType<typeof sketchInk>, id: string) =>
  strokes.find((s) => s.id === id);

describe('what the pen draws', () => {
  const strokes = sketchInk(defaultPose(), 0);

  it('covers the construction figure: shapes, bones, joints, parts, face', () => {
    const ids = strokes.map((s) => s.id);
    for (const expected of [
      'spine', 'neck', 'chest', 'pelvis', 'head',
      'armL0', 'armL1', 'armR0', 'armR1', 'legL0', 'legL1', 'legR0', 'legR1',
      'face-eye', 'face-center',
      'handL', 'handR', 'footL', 'footR',
      'finger-thumbL', 'finger-indexL', 'finger-middleR', 'finger-pinkyR',
      'joint-shoulderL', 'joint-elbowR', 'joint-wristL', 'joint-kneeR', 'joint-ankleL',
    ]) {
      expect(ids).toContain(expected);
    }
  });

  it('hands are a palm plus five drawn fingers that follow their poses', () => {
    expect(strokes.filter((s) => s.id.startsWith('finger-'))).toHaveLength(10);
    // Curl the left middle finger down: its stroke follows; its neighbours
    // hold still.
    const bent = resolveDrag(
      defaultPose(), dragTargetFor('middleL1')!,
      solveWorld(defaultPose()).wristL.x - 2, solveWorld(defaultPose()).wristL.y - 7,
    );
    const before = byId(strokes, 'finger-middleL')!.points;
    const after = byId(sketchInk(bent, 0), 'finger-middleL')!.points;
    expect(after[after.length - 1].y).toBeLessThan(before[before.length - 1].y - 3);
    const ringBefore = byId(strokes, 'finger-ringL')!.points[0];
    const ringAfter = byId(sketchInk(bent, 0), 'finger-ringL')!.points[0];
    expect(ringAfter.x).toBeCloseTo(ringBefore.x, 6);
    expect(ringAfter.y).toBeCloseTo(ringBefore.y, 6);
  });

  it('draws the body masses, hands and feet as CLOSED shapes', () => {
    for (const id of ['chest', 'pelvis', 'head', 'handL', 'handR', 'footL', 'footR']) {
      expect(byId(strokes, id)!.closed).toBe(true);
    }
    for (const id of ['spine', 'armL0', 'legR1', 'face-eye', 'face-center']) {
      expect(byId(strokes, id)!.closed).toBe(false);
    }
  });

  it('is deterministic — the same pose always draws the same figure', () => {
    const again = sketchInk(defaultPose(), 0);
    expect(JSON.stringify(again)).toBe(JSON.stringify(strokes));
  });
});

describe('pen and ink flair', () => {
  const strokes = sketchInk(defaultPose(), 0);

  it('tapers an open stroke toward its END', () => {
    for (const id of ['armL1', 'legR0', 'spine']) {
      const pts = byId(strokes, id)!.points;
      const startW = pts[1].w;
      const endW = pts[pts.length - 1].w;
      expect(endW).toBeLessThan(startW * 0.45);
    }
  });

  it('wobbles — no drawn bone is a perfect straight line', () => {
    // Perpendicular deviation from the ideal segment: present (humanity)
    // but bounded (the drawing still reads as the skeleton).
    const w = solveWorld(defaultPose());
    const seg = byId(strokes, 'legL0')!.points;
    const a = projectYaw(w.hipL.x, w.hipL.y, w.hipL.z, 0, w.root.x);
    const b = projectYaw(w.kneeL.x, w.kneeL.y, w.kneeL.z, 0, w.root.x);
    const dx = b.px - a.px;
    const dy = b.py - a.py;
    const len = Math.hypot(dx, dy);
    let maxDev = 0;
    for (const p of seg) {
      const dev = Math.abs(((p.x - a.px) * dy - (p.y - a.py) * dx) / len);
      maxDev = Math.max(maxDev, dev);
    }
    expect(maxDev).toBeGreaterThan(0.04);
    expect(maxDev).toBeLessThan(0.9);
  });

  it('keeps open strokes anchored — bones still meet their joints', () => {
    const w = solveWorld(defaultPose());
    const arm = byId(strokes, 'armL0')!.points;
    const shoulder = projectYaw(w.shoulderL.x, w.shoulderL.y, w.shoulderL.z, 0, w.root.x);
    const elbow = projectYaw(w.elbowL.x, w.elbowL.y, w.elbowL.z, 0, w.root.x);
    expect(Math.hypot(arm[0].x - shoulder.px, arm[0].y - shoulder.py)).toBeLessThan(0.6);
    const last = arm[arm.length - 1];
    expect(Math.hypot(last.x - elbow.px, last.y - elbow.py)).toBeLessThan(0.6);
  });

  it('runs nearly steady mid-stroke, so the taper reads as one smooth lift', () => {
    // Gentle pressure variation, never beads: the steady zone (past the
    // attack, before the taper starts at half-way) breathes a little and
    // no step between neighbours jumps.
    const leg = byId(strokes, 'legL0')!.points;
    const n = leg.length - 1;
    const mid = leg.slice(Math.round(0.22 * n), Math.round(0.48 * n)).map((p) => p.w);
    const spread = (Math.max(...mid) - Math.min(...mid)) / Math.max(...mid);
    expect(spread).toBeGreaterThan(0.01);
    expect(spread).toBeLessThan(0.2);
    for (let i = 1; i < leg.length; i++) {
      expect(Math.abs(leg[i].w - leg[i - 1].w)).toBeLessThan(0.3);
    }
  });

  it('starts strokes at slightly different pressures — per-stroke noise', () => {
    // The variety lives at the touch-down: the same-base-width bones open
    // at visibly different thicknesses.
    const starts = ['armL0', 'armR0', 'legL0', 'legR0', 'armL1', 'legR1']
      .map((id) => byId(strokes, id)!.points[0].w);
    const spread = (Math.max(...starts) - Math.min(...starts)) / Math.max(...starts);
    expect(spread).toBeGreaterThan(0.08);
  });

  it('gives every stroke its own character — no two identical wobbles', () => {
    const l = byId(strokes, 'legL0')!.points.map((p) => p.x);
    const r = byId(strokes, 'legR0')!.points.map((p) => p.x);
    const w = solveWorld(defaultPose());
    // Mirror the right leg onto the left and compare: the underlying bones
    // are symmetric, so any difference is the per-stroke hand.
    const mirrored = r.map((x) => 2 * w.root.x - x);
    const diff = l.map((x, i) => Math.abs(x - mirrored[i]));
    expect(Math.max(...diff)).toBeGreaterThan(0.05);
  });
});

describe('the face cross', () => {
  it('curves on the ball: eye line ends fold back as the head turns', () => {
    // Facing front, the eye line spans the head width; at a quarter turn
    // it wraps the visible hemisphere, so its projected span shrinks.
    const span = (yaw: number) => {
      const eye = byId(sketchInk(defaultPose(), yaw), 'face-eye')!;
      const xs = eye.points.map((p) => p.x);
      return Math.max(...xs) - Math.min(...xs);
    };
    expect(span(0)).toBeGreaterThan(14);
    expect(span(1.1)).toBeLessThan(span(0) * 0.85);
  });

  it('vanishes when the figure turns away', () => {
    const back = sketchInk(defaultPose(), Math.PI);
    expect(byId(back, 'face-eye')).toBeUndefined();
    expect(byId(back, 'face-center')).toBeUndefined();
    // The head OVAL still draws — a drawn ball has a back.
    expect(byId(back, 'head')!.points.length).toBeGreaterThan(8);
  });

  it('the center line is the vertical stroke, the eye line the horizontal', () => {
    const strokes = sketchInk(defaultPose(), 0);
    const spanOf = (id: string) => {
      const pts = byId(strokes, id)!.points;
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      return {
        x: Math.max(...xs) - Math.min(...xs),
        y: Math.max(...ys) - Math.min(...ys),
      };
    };
    const eye = spanOf('face-eye');
    const center = spanOf('face-center');
    expect(eye.x).toBeGreaterThan(eye.y * 2);
    expect(center.y).toBeGreaterThan(center.x * 2);
  });
});

describe('the drawing follows the pose and the turn', () => {
  it('a raised arm’s strokes rise with it', () => {
    // Raising the elbow carries the forearm rigidly, so it is the FOREARM
    // stroke that tops out high.
    const raised = resolveDrag(defaultPose(), dragTargetFor('elbowL')!, -32, 95);
    const arm = byId(sketchInk(raised, 0), 'armL1')!.points;
    expect(Math.max(...arm.map((p) => p.y))).toBeGreaterThan(90);
  });

  it('the chest rectangle rides a spine bend', () => {
    const w0 = solveWorld(defaultPose());
    const bent = resolveDrag(defaultPose(), dragTargetFor('spine')!, w0.root.x - 8, w0.root.y);
    const chest = byId(sketchInk(bent, 0), 'chest')!.points;
    const cx = chest.reduce((s, p) => s + p.x, 0) / chest.length;
    // The figure folded to its left: the whole rectangle went with it.
    expect(cx).toBeLessThan(w0.root.x - 8);
  });

  it('a collar tilt SHEARS the single chest solid — skinning, not a split', () => {
    // The chest's top rim is bound to the collar, its mid and bottom rims
    // to the chest joint: tilt the shoulders and the ONE closed shape
    // shears with them.
    const w0 = solveWorld(defaultPose());
    // A moderate tilt (~27°), so the sheared top corners stay on their
    // own sides of the center line where the test measures them.
    const tilted = resolveDrag(
      defaultPose(), dragTargetFor('collar')!, w0.chest.x - 2.3, w0.chest.y + 4.5,
    );
    // Measured at the two ENDS of the top rim — its outermost points above
    // the chest joint. The middle of that rim is a dome of its own, so
    // "the highest point on each side" would read the dome, not the shear.
    const topOf = (pose: typeof tilted, side: -1 | 1) => {
      const pts = sketchFills(pose, 0).find((f) => f.id === 'chest')!.points
        .filter((p) => p.y > w0.chest.y);
      return pts.reduce((best, p) =>
        (p.x - w0.chest.x) * side > (best.x - w0.chest.x) * side ? p : best).y;
    };
    // Level at rest; sheared once tilted — and still one closed stroke,
    // one fill.
    expect(Math.abs(topOf(defaultPose(), -1) - topOf(defaultPose(), 1))).toBeLessThan(1.5);
    expect(Math.abs(topOf(tilted, -1) - topOf(tilted, 1))).toBeGreaterThan(3.5);
    expect(byId(sketchInk(tilted, 0), 'chest')!.closed).toBe(true);
    expect(sketchFills(tilted, 0).filter((f) => f.id === 'chest')).toHaveLength(1);
  });

  describe('the chest’s top rim is skinned to the shoulders', () => {
    const w0 = solveWorld(defaultPose());
    /** The top rim: the chest hull's points above the chest joint, left to
     *  right, in the chest joint's own coordinates. */
    const rim = (pose: FiggiePose) => sketchFills(pose, 0)
      .find((f) => f.id === 'chest')!.points
      .filter((p) => p.y > w0.chest.y)
      .map((p) => ({ x: p.x - w0.chest.x, y: p.y - w0.chest.y }))
      .sort((a, b) => a.x - b.x);
    /** Every turn of a left-to-right run, as a cross product: all negative
     *  means the run bends one way the whole way across — a dome. */
    const turns = (pts: Array<{ x: number; y: number }>) => pts.slice(2).map((c, i) => {
      const [a, b] = [pts[i], pts[i + 1]];
      return (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    });
    /** Pull one shoulder up by `dy`. */
    const shrug = (side: 'L' | 'R', dy: number) => resolveDrag(
      defaultPose(), dragTargetFor(`shoulder${side}` as never)!,
      w0[`shoulder${side}`].x, w0[`shoulder${side}`].y + dy,
    );

    it('domes at rest, so there is a curve to move at all', () => {
      const rest = rim(defaultPose());
      expect(rest.length).toBeGreaterThanOrEqual(7);
      for (const t of turns(rest)) expect(t).toBeLessThan(0);
      // Symmetric, and the middle stands proud of the ends.
      expect(rest[0].y).toBeCloseTo(rest[rest.length - 1].y, 6);
      const mid = rest[Math.floor(rest.length / 2)];
      expect(mid.y).toBeGreaterThan(rest[0].y + 0.8);
    });

    /** How high the rim runs over the chest's centre line. */
    const overCentre = (pts: Array<{ x: number; y: number }>) => {
      const i = pts.findIndex((p) => p.x >= 0);
      const [a, b] = [pts[i - 1] ?? pts[i], pts[i]];
      return b.x === a.x ? b.y : a.y + (b.y - a.y) * ((0 - a.x) / (b.x - a.x));
    };

    it('carries that side of the rim with the shoulder, and holds the sternum', () => {
      const rest = rim(defaultPose());
      const up = rim(shrug('L', 4));
      // The rim's left end went up with the shoulder…
      expect(up[0].y).toBeGreaterThan(rest[0].y + 1);
      // …the right end stayed where it was — one shoulder, one side…
      expect(up[up.length - 1].y).toBeCloseTo(rest[rest.length - 1].y, 6);
      // …and over the sternum, weighted onto neither shoulder, the rim
      // barely stirred: the lift dies out across the chest — a quarter of
      // what the end travelled, at most — which is what makes it a curve
      // and not a lid being tipped.
      const end = up[0].y - rest[0].y;
      expect(Math.abs(overCentre(up) - overCentre(rest))).toBeLessThan(end * 0.25);
    });

    it('stays a curve under the shrug — it bends, never folds to a lid', () => {
      // Whichever way a shoulder goes, the rim over that half keeps a bend
      // in it: more than one point between the shoulder and the middle of
      // the chest, and the whole run still turning one way. A rigid top rim
      // could only ever be a straight lid, tilted.
      for (const dy of [4, -4]) {
        for (const side of ['L', 'R'] as const) {
          const pts = rim(shrug(side, dy));
          const moved = pts.filter((p) => (side === 'L' ? p.x < 0 : p.x > 0));
          expect(moved.length).toBeGreaterThanOrEqual(2);
          for (const t of turns(pts)) expect(t).toBeLessThan(0);
        }
      }
    });
  });

  it('the chest and pelvis trace their SILHOUETTES — never a flat plate', () => {
    // The masses are shallow volumes: face-on the chest's hull is the
    // classic rectangle; edge-on it is the side of the box — a drawn
    // shape with real width, where a flat plate collapsed to a line.
    const width = (id: string, yaw: number) => {
      const pts = byId(sketchInk(defaultPose(), yaw), id)!.points;
      const xs = pts.map((p) => p.x);
      return Math.max(...xs) - Math.min(...xs);
    };
    expect(width('chest', 0)).toBeGreaterThan(14); // the full rectangle
    expect(width('chest', Math.PI / 2)).toBeGreaterThan(5); // the box's side
    expect(width('pelvis', Math.PI / 2)).toBeGreaterThan(4);
    // And the fills follow the same silhouette, so occlusion matches the
    // outline at every view.
    const fills = sketchFills(defaultPose(), Math.PI / 2);
    const chestFill = fills.find((f) => f.id === 'chest')!;
    const xs = chestFill.points.map((p) => p.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(5);
  });

  it('the feet wedges swing into profile as the figure turns', () => {
    const depth = (yaw: number) => {
      const foot = byId(sketchInk(defaultPose(), yaw), 'footL')!.points;
      const xs = foot.map((p) => p.x);
      return Math.max(...xs) - Math.min(...xs);
    };
    // Splayed at rest, the wedge widens further once the turn brings the
    // foot's full length into view.
    expect(depth(Math.PI / 2)).toBeGreaterThan(depth(0) * 1.15);
  });
});

describe('the batch and the accent', () => {
  it('triangulates every stroke into one well-formed ribbon batch', () => {
    const strokes = sketchInk(defaultPose(), 0);
    const batch = inkBatch(strokes);
    const vertCount = batch.positions.length / 3;
    expect(batch.indices.length % 3).toBe(0);
    for (const i of batch.indices) expect(i).toBeLessThan(vertCount);
    // Two verts per point, two triangles per span.
    const pts = strokes.reduce((s, st) => s + (st.points.length >= 2 ? st.points.length : 0), 0);
    const spans = strokes.reduce(
      (s, st) => s + (st.points.length >= 2 ? st.points.length - 1 : 0), 0,
    );
    expect(vertCount).toBe(pts * 2);
    expect(batch.indices.length).toBe(spans * 6);
  });

  it('fills the chest, pelvis and head as solid masses WITH depth', () => {
    const fills = sketchFills(defaultPose(), 0);
    expect(fills.map((f) => f.id)).toEqual([
      // One solid per hand — the palm is skinned, not split in two.
      'chest', 'pelvis', 'handL', 'handR',
      'footL', 'footR', 'toeL', 'toeR', 'head',
    ]);
    // Each solid sits BEHIND its own outline (the strokes at that plane
    // must win the depth test), and everything is a real polygon.
    const strokes = sketchInk(defaultPose(), 0);
    for (const f of fills) {
      expect(f.points.length).toBeGreaterThanOrEqual(3);
      const outline = byId(strokes, f.id)!.points;
      const strokeZ = Math.min(...outline.map((p) => p.z));
      for (const p of f.points) expect(p.z).toBeLessThan(strokeZ);
    }
    // A far-side stroke really is behind the fill: turn the figure and
    // compare the far wrist's depth to the chest plane (positive yaw
    // swings the RIGHT side away from the viewer).
    const turned = sketchInk(defaultPose(), 1.2);
    const farWrist = byId(turned, 'joint-wristR')!.points[0];
    const chestFill = sketchFills(defaultPose(), 1.2)[0];
    const chestZ = chestFill.points.reduce((s, p) => s + p.z, 0) / chestFill.points.length;
    expect(farWrist.z).toBeLessThan(chestZ);
  });

  it('marks every fingertip with a tiny ring — 30% of the elbow’s circle', () => {
    const strokes = sketchInk(defaultPose(), 0);
    const span = (id: string) => {
      const xs = byId(strokes, id)!.points.map((p) => p.x);
      return Math.max(...xs) - Math.min(...xs);
    };
    for (const side of ['L', 'R'] as const) {
      for (const name of ['thumb', 'index', 'middle', 'ring', 'pinky']) {
        expect(byId(strokes, `joint-${name}${side}3`)).toBeDefined();
      }
    }
    // The end-effector mark reads at a third of the elbow's circle.
    const ratio = span('joint-middleL3') / span('joint-elbowL');
    expect(ratio).toBeGreaterThan(0.2);
    expect(ratio).toBeLessThan(0.45);
    // And a grabbed fingertip recolors ITS OWN ring — same conservation
    // as every circled joint.
    const idle = buildInkDraw(defaultPose(), 0, null);
    const held = buildInkDraw(defaultPose(), 0, 'middleL3');
    expect(held.main.positions.length + held.accent!.positions.length)
      .toBe(idle.main.positions.length);
  });

  it('the toe effector draws NO circle at rest — only blue while grabbed', () => {
    // The foot stays a clean pair of boxes; the toe's marker exists only
    // as grab feedback, through the accent fallback.
    const idle = sketchInk(defaultPose(), 0);
    expect(idle.some((s) => s.id.startsWith('joint-toe'))).toBe(false);
    const held = buildInkDraw(defaultPose(), 0, 'toeL');
    expect(held.accent!.indices.length).toBeGreaterThan(0);
    expect(held.main.positions.length)
      .toBe(buildInkDraw(defaultPose(), 0, null).main.positions.length);
  });

  it('the wrist sits BEFORE the palm volume, the ankle ABOVE the foot’s', () => {
    // The joint circles must read as joints — outside their volumes, not
    // buried in them: the palm box starts beyond the wrist's circle, and
    // the foot box's top face sits below the ankle's.
    const fills = sketchFills(defaultPose(), 0);
    const w = solveWorld(defaultPose());
    for (const p of fills.find((f) => f.id === 'handL')!.points) {
      expect(p.x).toBeLessThan(w.wristL.x - 1.2);
    }
    for (const p of fills.find((f) => f.id === 'handR')!.points) {
      expect(p.x).toBeGreaterThan(w.wristR.x + 1.2);
    }
    for (const side of ['footL', 'footR'] as const) {
      for (const p of fills.find((f) => f.id === side)!.points) {
        expect(p.y).toBeLessThan(w.ankleL.y - 1.2);
      }
    }
  });

  it('buries the foot’s own joints IN its boxes, not on top of them', () => {
    // The other half of the same rule: the ankle is a joint and reads as
    // one, but heel, ball and toe are the foot's INSIDES. The L drops them
    // into the flesh, so each sits between its box's top and bottom faces
    // rather than perched on the top edge the way the old chain did.
    const fills = sketchFills(defaultPose(), 0);
    const w = solveWorld(defaultPose());
    const box = (id: string) => {
      const ys = fills.find((f) => f.id === id)!.points.map((p) => p.y);
      return { top: Math.max(...ys), bottom: Math.min(...ys) };
    };
    for (const s of ['L', 'R'] as const) {
      const body = box(`foot${s}`);
      const toeBox = box(`toe${s}`);
      for (const [joint, b] of [
        [`heel${s}`, body], [`ball${s}`, body], [`toe${s}`, toeBox],
      ] as const) {
        expect(w[joint].y).toBeLessThan(b.top - 0.5);
        expect(w[joint].y).toBeGreaterThan(b.bottom + 0.5);
      }
      // And the L's upright joins the two: a drawn bone from the ankle down
      // into the foot, so the ankle circle never floats free of it.
      const shin = sketchInk(defaultPose(), 0).find((st) => st.id === `heel${s}`)!.points;
      expect(shin[0].y).toBeCloseTo(w[`ankle${s}`].y, 2);
      expect(shin[shin.length - 1].y).toBeCloseTo(w[`heel${s}`].y, 2);
    }
  });

  it('the hand draws with a lighter pen — the palm at half the body’s weight', () => {
    const strokes = sketchInk(defaultPose(), 0);
    const maxW = (id: string) =>
      Math.max(...strokes.find((s) => s.id === id)!.points.map((p) => p.w));
    // Palm outline vs the chest's; finger vs a limb bone.
    expect(maxW('handL')).toBeLessThan(maxW('chest') * 0.62);
    expect(maxW('finger-middleL')).toBeLessThan(maxW('armL0') * 0.6);
    // The fingers are the exception to the light hand: five lines side by
    // side need a little more weight or the hand reads as hatching. They
    // still come in under the palm they hang off.
    expect(maxW('finger-middleL')).toBeGreaterThan(maxW('armL0') * 0.3);
    expect(maxW('finger-middleL')).toBeLessThan(maxW('handL'));
  });

  it('batches the fills as depth geometry alongside the ink', () => {
    const draw = buildInkDraw(defaultPose(), 0, null);
    expect(draw.fills.indices.length).toBeGreaterThan(0);
    expect(draw.fills.positions.length % 3).toBe(0);
    for (const i of draw.fills.indices) {
      expect(i).toBeLessThan(draw.fills.positions.length / 3);
    }
  });

  it('a held joint RECOLORS its own circle — no second ring, drawn on top', () => {
    // The accent batch is the joint's exact drawn circle (same stroke,
    // same size) lifted OUT of the ink batch; the renderer paints it last
    // with depth off, so even a joint buried inside a solid mass surfaces
    // blue while held.
    const idle = buildInkDraw(defaultPose(), 0, null);
    const held = buildInkDraw(defaultPose(), 0, 'elbowL');
    expect(held.accent!.positions.length).toBeGreaterThan(0);
    // Same total geometry, split differently: ink lost exactly what the
    // accent gained.
    expect(held.main.positions.length + held.accent!.positions.length)
      .toBe(idle.main.positions.length);
    // A circle-less joint (the chest, buried in its rectangle) still gets
    // a modest marker in the same style.
    const chest = buildInkDraw(defaultPose(), 0, 'chest');
    expect(chest.accent!.positions.length).toBeGreaterThan(0);
    expect(chest.main.positions.length).toBe(idle.main.positions.length);
  });

  it('adds the accent marker only while a joint is held', () => {
    expect(buildInkDraw(defaultPose(), 0, null).accent).toBeNull();
    const held = buildInkDraw(defaultPose(), 0, 'elbowL');
    expect(held.accent).not.toBeNull();
    expect(held.accent!.indices.length).toBeGreaterThan(0);
    // The marker sits on the held joint.
    const w = solveWorld(defaultPose());
    const p = projectYaw(w.elbowL.x, w.elbowL.y, w.elbowL.z, 0, w.root.x);
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < held.accent!.positions.length; i += 3) {
      xs.push(held.accent!.positions[i]);
      ys.push(held.accent!.positions[i + 1]);
    }
    const cx = xs.reduce((s, x) => s + x, 0) / xs.length;
    const cy = ys.reduce((s, y) => s + y, 0) / ys.length;
    expect(Math.hypot(cx - p.px, cy - p.py)).toBeLessThan(1.5);
  });
});

describe('the vector bake', () => {
  const polys = inkVector(defaultPose(), 0);

  it('turns every drawn stroke into closed, fillable ribbons', () => {
    const ids = new Set(polys.map((p) => p.id));
    for (const expected of ['spine', 'chest', 'armL0', 'head', 'joint-kneeR', 'footL']) {
      expect(ids).toContain(expected);
    }
    // A ribbon outline is two edges of the same run: an even point count,
    // at least a segment's worth.
    for (const p of polys) {
      expect(p.points.length).toBeGreaterThanOrEqual(4);
      expect(p.points.length % 2).toBe(0);
      for (const q of p.points) {
        expect(Number.isFinite(q.x)).toBe(true);
        expect(Number.isFinite(q.y)).toBe(true);
      }
    }
  });

  it('traces the same ribbon the GL batch triangulates', () => {
    // The bake is the drawing, not a second drawing of it: the left edge
    // of a poly's first sample IS the batch's first vertex.
    const stroke = sketchInk(defaultPose(), 0).find((s) => s.id === 'spine')!;
    const batch = inkBatch([stroke]);
    const spine = polys.find((p) => p.id === 'spine')!;
    // (the batch rounds to float32 on the way into its buffer)
    expect(spine.points[0].x).toBeCloseTo(batch.positions[0], 4);
    expect(spine.points[0].y).toBeCloseTo(batch.positions[1], 4);
  });

  it('hides what a solid mass covers — a turned figure loses its far arm', () => {
    // Face the figure three-quarters away: the far upper arm passes behind
    // the chest slab, so its stroke comes back clipped (or gone).
    const turned = inkVector(defaultPose(), 2.2);
    const front = polys.filter((p) => p.id === 'armR0');
    const behind = turned.filter((p) => p.id === 'armR0');
    const span = (runs: typeof polys) =>
      runs.reduce((n, r) => n + r.points.length, 0);
    expect(span(front)).toBeGreaterThan(0);
    expect(span(behind)).toBeLessThan(span(front));
  });

  it('never lets a shape erase its own outline', () => {
    // The masses sit FILL_BIAS behind their own outlines, so however the
    // figure turns the chest still traces itself — the only bite out of it
    // is where the pelvis solid genuinely crosses in front, exactly as the
    // depth buffer clips it on the stage.
    const drawn = sketchInk(defaultPose(), 0).find((s) => s.id === 'chest')!.points.length;
    for (const yaw of [0, 0.9, 2.2, -1.4]) {
      const runs = inkVector(defaultPose(), yaw).filter((p) => p.id === 'chest');
      expect(runs.length).toBeGreaterThan(0);
      const kept = runs.reduce((n, r) => n + r.points.length / 2, 0);
      expect(kept).toBeGreaterThan(drawn * 0.6);
    }
  });

  it('stays a modest amount of geometry — this bakes into every thumbnail', () => {
    expect(polys.length).toBeLessThan(220);
    expect(polys.reduce((n, p) => n + p.points.length, 0)).toBeLessThan(6000);
  });
});

describe('the palm is one skinned solid', () => {
  /** The palm-bend effector, folded in the view plane. */
  const bentPalm = (angle: number) => ({
    ...defaultPose(),
    angles: { knuckL: quatFromAxisAngle(0, 0, 1, angle) },
  });

  it('draws ONE shape per hand, not an inner and an outer plate', () => {
    const ids = sketchInk(defaultPose(), 0).map((s) => s.id);
    expect(ids).toContain('handL');
    expect(ids).toContain('handR');
    expect(ids).not.toContain('handOutL');
    expect(ids).not.toContain('handOutR');
  });

  it('kinks at the pin when the palm bends, staying one connected shape', () => {
    // The mid rim rides the hinge, so bending shears the box: the outer
    // half swings and the wrist half holds still — one silhouette, bent,
    // rather than two shapes coming apart.
    const flat = sketchFills(defaultPose(), 0).find((f) => f.id === 'handL')!;
    const bent = sketchFills(bentPalm(0.8), 0).find((f) => f.id === 'handL')!;
    const spanY = (f: typeof flat) => {
      const ys = f.points.map((p) => p.y);
      return Math.max(...ys) - Math.min(...ys);
    };
    expect(spanY(bent)).toBeGreaterThan(spanY(flat) * 1.15);
    // …and the wrist end of it did NOT move (that rim rides the pin).
    const wristEnd = (f: typeof flat) => Math.max(...f.points.map((p) => p.x));
    expect(wristEnd(bent)).toBeCloseTo(wristEnd(flat), 6);
  });

  it('starts beyond the wrist’s own circle, and is shorter than the reach', () => {
    const fill = sketchFills(defaultPose(), 0).find((f) => f.id === 'handL')!;
    const world = solveWorld(defaultPose());
    const inner = Math.max(...fill.points.map((p) => p.x));
    // The left hand reaches out along −x: the solid begins past the wrist
    // joint, so the drawn wrist circle is never buried inside it.
    expect(inner).toBeLessThan(world.wristL.x);
    // …and it ends at the knuckle line, where the fingers hang.
    const outer = Math.min(...fill.points.map((p) => p.x));
    expect(outer).toBeCloseTo(world.knuckL.x, 6);
    expect(inner - outer).toBeLessThan(Math.abs(world.wristL.x - world.knuckL.x));
  });
});
