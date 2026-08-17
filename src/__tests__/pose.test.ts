/**
 * The posing contract: FK down the hierarchy, the three drag behaviours
 * (translate / rotate-parent-bone / 2-bone IK), and the serialization that
 * lets a host store a pose as plain JSON.
 */

import {
  FiggiePose, defaultPose, normalizeAngle, poseEquals, poseReach, resolveDrag, rootLimit,
  sanitizePose, solveWorld,
} from '../pose';
import { pushPose } from '../push';
import { STAGE, Turn, projectTurn, projectYaw, turnQuat } from '../view';
import {
  BODY_BLOBS, BODY_CAPSULES, DRAG_TARGETS, DragTarget, HAND_SPAN, JOINT_IDS, MAX_REACH,
  PUSH_ROOM, RIG_HEIGHT, SKELETON, STAGE_REACH, dragTargetFor, jointBound, restJoint,
} from '../skeleton';

const target = (joint: string) => dragTargetFor(joint as never)!;

/** The translate drag, built by hand: no target offers it any more (a
 *  press on the hips poses the figure, it does not pick it up), but the
 *  pose model still answers for the behaviour a host can ask for. */
const ROOT_DRAG: DragTarget = { joint: 'root', kind: 'translate' };

/** Everything the figure draws sits inside the stage, under every turn —
 *  the promise the viewport rests on: a rig is never drawn clipped. */
function expectInsideStage(pose: FiggiePose): void {
  for (const turn of [0, 0.8, 1.9, -2.6, Math.PI]) {
    const world = solveWorld(pose);
    const q = turnQuat(turn);
    for (const id of JOINT_IDS) {
      const j = world[id];
      const p = projectTurn(j.x, j.y, j.z, q, world.root.x, world.root.y);
      const b = jointBound(id);
      expect(p.px - b).toBeGreaterThanOrEqual(STAGE.minX - 1e-9);
      expect(p.px + b).toBeLessThanOrEqual(STAGE.maxX + 1e-9);
      expect(p.py - b).toBeGreaterThanOrEqual(STAGE.minY - 1e-9);
      expect(p.py + b).toBeLessThanOrEqual(STAGE.maxY + 1e-9);
    }
  }
}

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

  it('keeps every joint in the posing plane — except the feet', () => {
    // Depth belongs to flesh — with ONE exception: the foot chain points at
    // the viewer, and its stance splay is what keeps it poseable face-on.
    // The heel steps BACKWARD down the same splayed line (it is the L's
    // upright, behind the ankle); ball and toe run forward along the floor.
    // Everything else stays in the rig plane.
    for (const j of SKELETON) {
      if (/^heel[LR]$/.test(j.id)) {
        expect(j.dz).toBeLessThan(0);
      } else if (/^(ball|toe)[LR]$/.test(j.id)) {
        expect(j.dz).toBeGreaterThan(0);
      } else {
        expect(j.dz).toBe(0);
      }
    }
  });
});

describe('the flesh on the bones', () => {
  const world = solveWorld(defaultPose());
  const on = (joint: string) => BODY_BLOBS.filter((b) => b.joint === joint);
  const capsule = (a: string, b: string) =>
    BODY_CAPSULES.find((c) => c.a === a && c.b === b)!;

  it('has a waist: the spinal column is slimmer than the masses it joins', () => {
    // What makes a bend at spine or chest read as a bend — before, one
    // uniform sausage ran pelvis to shoulders and nothing showed.
    const pelvis = on('root')[0];
    const ribcage = on('chest')[0];
    expect(capsule('root', 'spine').radius).toBeLessThan(pelvis.rx);
    expect(capsule('spine', 'chest').radius).toBeLessThan(ribcage.rx);
    // …and the ribcage is the broader of the two masses, so the figure
    // tapers downward like a torso rather than a tube.
    expect(ribcage.rx).toBeGreaterThan(capsule('root', 'spine').radius * 1.5);
  });

  it('has hips: a ball at each socket, outboard of the pelvis', () => {
    for (const side of ['hipL', 'hipR'] as const) {
      const ball = on(side)[0];
      expect(ball).toBeDefined();
      // The ball reaches wider than the pelvis pear, so the hip line shows.
      const reach = Math.abs(world[side].x) + ball.rx;
      expect(reach).toBeGreaterThan(on('root')[0].rx);
      // The thigh leaves from inside it.
      expect(ball.ry).toBeGreaterThan(capsule(side, side === 'hipL' ? 'kneeL' : 'kneeR').radius);
    }
  });

  it('has hands: a two-half palm and five three-segment fingers per wrist', () => {
    for (const side of ['wristL', 'wristR'] as const) {
      const s = side === 'wristL' ? 'L' : 'R';
      // The palm's flesh hangs in two flat halves on its own chain, so
      // the classic look bends with the palm effector too.
      for (const half of [`palm${s}`, `knuck${s}`]) {
        const blob = on(half)[0];
        expect(blob).toBeDefined();
        expect(blob.ry).toBeLessThan(blob.rx);
      }
      const reach = (name: string) => {
        const tip = world[`${name}${s}3` as keyof typeof world];
        const w = world[side];
        return Math.hypot(tip.x - w.x, tip.y - w.y);
      };
      for (const name of ['thumb', 'index', 'middle', 'ring', 'pinky']) {
        // Four joints per finger: a rigid base knuckle + three POSABLE
        // segments, each a thin drawn shaft.
        expect(restJoint(`${name}${s}0` as never).posable).toBe(false);
        for (const seg of [1, 2, 3]) {
          const j = restJoint(`${name}${s}${seg}` as never);
          expect(j.posable).toBe(true);
          expect(BODY_CAPSULES.find((c) => c.b === j.id)!.radius).toBeLessThan(1);
        }
      }
      // The thumb reaches shortest, high and inboard; middle the longest,
      // and exactly the span the fine-grab zoom gate measures.
      expect(reach('thumb')).toBeLessThan(reach('pinky'));
      for (const name of ['thumb', 'index', 'ring', 'pinky']) {
        expect(reach('middle')).toBeGreaterThanOrEqual(reach(name));
      }
      expect(reach('middle')).toBeCloseTo(HAND_SPAN, 0);
      // The MIDDLE FINGER is as long as the palm (wrist to knuckle line).
      const mid = world[`middle${s}3` as keyof typeof world];
      const base = world[`middle${s}0` as keyof typeof world];
      const knuck = world[`knuck${s}` as keyof typeof world];
      const fingerLen = Math.hypot(mid.x - base.x, mid.y - base.y);
      const palmLen = Math.hypot(knuck.x - world[side].x, knuck.y - world[side].y) - 1.3;
      expect(fingerLen).toBeCloseTo(palmLen, 0);
    }
  });

  it('the collar tilts the SHOULDER LINE — neck and head ride along', () => {
    // Drag the collar joint: the shoulders see-saw (one up, one down),
    // the arms ride, and the whole girdle — neck and head included —
    // leans with it. Only the chest below holds still.
    const w0 = solveWorld(defaultPose());
    const p = resolveDrag(
      defaultPose(), target('collar'), w0.chest.x - 4, w0.chest.y + 3,
    );
    const w = solveWorld(p);
    expect(Object.keys(p.angles)).toEqual(['collar']);
    expect(w.shoulderL.y).toBeLessThan(w0.shoulderL.y - 3);
    expect(w.shoulderR.y).toBeGreaterThan(w0.shoulderR.y + 3);
    expect(w.wristL.y).toBeLessThan(w0.wristL.y - 3); // the arm rides
    // The neck joint moves with the shoulders, carrying the head.
    expect(w.neck.x).toBeLessThan(w0.neck.x - 3);
    expect(w.head.x).toBeLessThan(w0.head.x - 8);
    expect(w.chest.y).toBeCloseTo(w0.chest.y, 6);
    // A see-saw, not a stretch: shoulder span and neck riser both keep
    // their lengths.
    expect(Math.hypot(w.shoulderR.x - w.shoulderL.x, w.shoulderR.y - w.shoulderL.y))
      .toBeCloseTo(19, 6);
    expect(Math.hypot(w.neck.x - w.collar.x, w.neck.y - w.collar.y)).toBeCloseTo(2, 6);
  });

  it('the palm bends in the middle: the knuckle effector hinges at the pin', () => {
    // Drag the knuckle-line joint down: the outer palm and all four
    // fingers swing about the MID-PALM pin; the pin, the wrist and the
    // thumb (inner-palm rider) hold still.
    const w0 = solveWorld(defaultPose());
    const p = resolveDrag(
      defaultPose(), target('knuckL'), w0.palmL.x - 1.2, w0.palmL.y - 2.2,
    );
    const w = solveWorld(p);
    expect(Object.keys(p.angles)).toEqual(['knuckL']);
    expect(w.knuckL.y).toBeLessThan(w0.knuckL.y - 1);
    expect(w.middleL3.y).toBeLessThan(w0.middleL3.y - 2);
    expect(w.palmL.x).toBeCloseTo(w0.palmL.x, 6);
    expect(w.palmL.y).toBeCloseTo(w0.palmL.y, 6);
    expect(w.wristL.y).toBeCloseTo(w0.wristL.y, 6);
    expect(w.thumbL3.y).toBeCloseTo(w0.thumbL3.y, 6);
    // The bend preserves the outer palm's length — a hinge, not a stretch.
    const span = Math.hypot(w.knuckL.x - w.palmL.x, w.knuckL.y - w.palmL.y);
    expect(span).toBeCloseTo(Math.hypot(
      w0.knuckL.x - w0.palmL.x, w0.knuckL.y - w0.palmL.y,
    ), 6);
  });

  it('finger segments are FINE drag targets — zoom-gated, knobless', () => {
    const fine = DRAG_TARGETS.filter((t) => t.fine);
    // 3 segments x 5 fingers x 2 hands, plus each hand's palm effector and
    // each foot's HEEL — the joint that only separates from the ankle
    // above it zoomed in. The ball is grabbable at any size (see below).
    expect(fine).toHaveLength(34);
    expect(fine.map((t) => t.joint)).toEqual(
      expect.arrayContaining(['heelL', 'heelR']),
    );
    expect(fine.map((t) => t.joint)).not.toEqual(
      expect.arrayContaining(['ballL', 'ballR']),
    );
    for (const t of fine) expect(t.kind).toBe('fk');
    // A middle segment poses like any FK joint: the tip rides rigidly,
    // the base joint below it holds still.
    const w0 = solveWorld(defaultPose());
    const p = resolveDrag(
      defaultPose(), target('middleL2'), w0.middleL1.x - 1, w0.middleL1.y - 2,
    );
    const w = solveWorld(p);
    expect(w.middleL3.y).toBeLessThan(w0.middleL3.y - 0.5);
    expect(w.middleL1.x).toBeCloseTo(w0.middleL1.x, 6);
    expect(w.wristL.x).toBeCloseTo(w0.wristL.x, 6);
  });

  it('has feet: an L of ankle→heel→ball→toe, heel block riding the heel', () => {
    for (const s of ['L', 'R'] as const) {
      const heel = restJoint(`heel${s}` as never);
      const ball = restJoint(`ball${s}` as never);
      const toe = restJoint(`toe${s}` as never);
      // The L's UPRIGHT: from the ankle the first bone drops, and drops far
      // more than it steps back.
      expect(heel.parent).toBe(`ankle${s}`);
      expect(heel.dy).toBeLessThan(-2);
      expect(heel.dz).toBeLessThan(0); // behind the ankle
      expect(Math.abs(heel.dy)).toBeGreaterThan(Math.hypot(heel.dx, heel.dz));
      // The L's FOOT: heel to ball to toe, forward (+z) and splayed outward
      // so the foot stays poseable face-on, and near enough level that the
      // sole lies along the floor rather than ramping down it.
      expect(ball.parent).toBe(`heel${s}`);
      expect(toe.parent).toBe(`ball${s}`);
      expect(ball.dz).toBeGreaterThan(2);
      expect(toe.dz).toBeGreaterThan(2);
      expect(Math.sign(ball.dx)).toBe(s === 'L' ? -1 : 1);
      for (const step of [ball, toe]) {
        expect(Math.abs(step.dy)).toBeLessThan(Math.hypot(step.dx, step.dz) * 0.1);
      }
      // The heel block rides the heel joint itself, no offset needed, and
      // every bone of the L is a drawn shaft.
      const block = on(`heel${s}`);
      expect(block).toHaveLength(1);
      expect([block[0].ox, block[0].oy, block[0].oz]).toEqual([0, 0, 0]);
      expect(on(`ankle${s}`)).toHaveLength(0);
      for (const b of [`heel${s}`, `ball${s}`, `toe${s}`]) {
        expect(BODY_CAPSULES.find((c) => c.b === b)).toBeDefined();
      }
    }
  });

  it('sits every foot joint INSIDE the foot, not on top of it', () => {
    // The complaint the L fixes: the old chain hung off the ankle at ankle
    // height, so the ball perched on the foot's top face. Now each of heel,
    // ball and toe is buried in flesh — the widest capsule or blob meeting
    // it reaches both above and below the joint — and the whole foot's
    // underside sits on the floor the figure stands on.
    const w = solveWorld(defaultPose());
    for (const s of ['L', 'R'] as const) {
      const parts = [`heel${s}`, `ball${s}`, `toe${s}`] as const;
      // The foot's own flesh — the heel block and the two shafts along the
      // floor, NOT the shaft dropping from the ankle into it.
      const reach: number[] = [];
      for (const id of parts) {
        for (const c of BODY_CAPSULES) {
          if ((c.a === id || c.b === id) && c.a !== `ankle${s}`) {
            reach.push(w[id].y + c.radius, w[id].y - c.radius);
          }
        }
        for (const b of on(id)) reach.push(w[id].y + b.ry, w[id].y - b.ry);
      }
      const sole = Math.min(...reach);
      const top = Math.max(...reach);
      expect(sole).toBeCloseTo(0, 6); // the figure stands ON the floor
      for (const id of parts) {
        expect(w[id].y).toBeGreaterThan(sole + 0.5);
        expect(w[id].y).toBeLessThan(top - 0.5); // NOT perched on the top face
        expect(w[id].y).toBeLessThan(w[`ankle${s}`].y - 2);
      }
    }
  });

  it('the toe is an IK end effector: drag it and the foot bends at the ball', () => {
    const t = dragTargetFor('toeL')!;
    expect(t.kind).toBe('ik2');
    expect(t.chain).toEqual(['ballL', 'toeL']);
    expect(t.fine).toBeUndefined(); // a toe is a whole-figure move, not detail
    // Reach the toe toward a point INSIDE the chain's apparent reach: it
    // lands there (projected), the ankle holds, and the ball bends.
    const w0 = solveWorld(defaultPose());
    const ap = projectYaw(w0.ankleL.x, w0.ankleL.y, w0.ankleL.z, 0, w0.root.x);
    const target0 = { px: ap.px - 1.5, py: ap.py - 3.0 };
    const p = resolveDrag(defaultPose(), t, target0.px, target0.py);
    const w = solveWorld(p);
    const tp = projectYaw(w.toeL.x, w.toeL.y, w.toeL.z, 0, w.root.x);
    expect(tp.px).toBeCloseTo(target0.px, 2);
    expect(tp.py).toBeCloseTo(target0.py, 2);
    expect(w.ankleL.y).toBeCloseTo(w0.ankleL.y, 6);
    expect(Object.keys(p.angles).sort()).toEqual(['ballL', 'toeL']);
  });

  it('every blob hangs on a joint that exists', () => {
    for (const b of BODY_BLOBS) expect(JOINT_IDS).toContain(b.joint);
    for (const c of BODY_CAPSULES) {
      expect(JOINT_IDS).toContain(c.a);
      expect(JOINT_IDS).toContain(c.b);
    }
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
    resolveDrag(pose, ROOT_DRAG, 10, 10);
    expect(pose).toEqual(defaultPose());
  });
});

describe('root drag (translate)', () => {
  it('carries the whole figure without re-posing it', () => {
    const bent = resolveDrag(defaultPose(), target('elbowL'), -20, 90);
    const moved = resolveDrag(bent, ROOT_DRAG, 8, 48);
    const w = solveWorld(moved);
    expect(w.root.x).toBeCloseTo(8, 6);
    expect(w.root.y).toBeCloseTo(48, 6);
    // The elbow pose survived the move verbatim.
    expect(moved.angles).toEqual(bent.angles);
  });

  it('stops at the stage edge — the figure can never be dragged out of view', () => {
    const p = resolveDrag(defaultPose(), ROOT_DRAG, 10000, -10000);
    const limit = rootLimit(solveWorld(defaultPose()));
    expect(limit).toBeGreaterThan(0);
    expect(p.rootX).toBeCloseTo(limit, 9);
    expect(p.rootY).toBeCloseTo(-limit, 9);
    expectInsideStage(p);
  });

  it('gives a reaching pose less room to travel than a resting one', () => {
    // The room IS the stage minus the pose's own reach: fling an arm
    // straight up and the figure has correspondingly less room to walk.
    const reaching = resolveDrag(defaultPose(), target('wristL'), 0, 10_000);
    expect(poseReach(solveWorld(reaching)))
      .toBeGreaterThan(poseReach(solveWorld(defaultPose())));
    expect(rootLimit(solveWorld(reaching)))
      .toBeLessThan(rootLimit(solveWorld(defaultPose())));
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

// A PUSHED rig carries per-joint displacements (FiggiePose.offsets): the
// joint is drawn away from where its bone seats it, while its children still
// hang off the seat. Every drag has to read the two apart — see resolveDrag's
// `seat` — or the angle it solves for lands the joint somewhere other than
// the finger, and re-solving from there each frame makes the joint flip
// between two positions for as long as it is held.
describe('drags on a PUSHED rig (joints carrying displacements)', () => {
  /** The rig after a shove centred on `joint`, in the face-on view. */
  const pushedAt = (joint: string, dx: number, dy: number, radius: number): FiggiePose => {
    const w = solveWorld(defaultPose());
    const j = w[joint as keyof typeof w];
    const at = projectYaw(j.x, j.y, j.z, 0, w.root.x);
    const pushed = pushPose(defaultPose(), 0, at.px, at.py, dx, dy, radius);
    expect(pushed.offsets).toBeDefined();
    return pushed;
  };

  const seen = (pose: FiggiePose, joint: string) => {
    const w = solveWorld(pose);
    const j = w[joint as keyof typeof w];
    return projectYaw(j.x, j.y, j.z, 0, w.root.x);
  };

  it('settles where it is dragged instead of flipping between two places', () => {
    // The exact shape of the bug: a finger held STILL, and the solve run
    // again each frame as the gesture does. Before the seat/drawn split
    // these two answers chased each other — this chest drag flipped ~16 rig
    // units, a third of the figure, every frame.
    const pushed = pushedAt('chest', 16, -4, 25);
    const from = seen(pushed, 'chest');
    const finger = { px: from.px, py: from.py - 5 };
    let pose = pushed;
    const track: Array<{ px: number; py: number }> = [];
    for (let i = 0; i < 6; i++) {
      pose = resolveDrag(pose, target('chest'), finger.px, finger.py, 0, false);
      track.push(seen(pose, 'chest'));
    }
    for (const p of track.slice(1)) {
      expect(p.px).toBeCloseTo(track[0].px, 6);
      expect(p.py).toBeCloseTo(track[0].py, 6);
    }
  });

  it('swings a displaced joint about where its bone is SEATED', () => {
    // The pivot is the parent's undisplaced position, and the joint keeps
    // its distance from THAT — displacement and all, carried round rigidly.
    const pushed = pushedAt('elbowL', 0, -6, 25);
    const seat = solveWorld({ ...pushed, offsets: undefined });
    const pivot = projectYaw(seat.shoulderL.x, seat.shoulderL.y, seat.shoulderL.z, 0, seat.root.x);
    const before = seen(pushed, 'elbowL');
    const r = Math.hypot(before.px - pivot.px, before.py - pivot.py);
    const finger = { px: pivot.px - 3, py: pivot.py - 20 };
    const after = seen(resolveDrag(pushed, target('elbowL'), finger.px, finger.py, 0, false), 'elbowL');
    expect(Math.hypot(after.px - pivot.px, after.py - pivot.py)).toBeCloseTo(r, 5);
    // …and it points at the finger, in ONE solve — no walking toward it.
    expect(Math.atan2(after.py - pivot.py, after.px - pivot.px))
      .toBeCloseTo(Math.atan2(finger.py - pivot.py, finger.px - pivot.px), 6);
  });

  it('lands a pushed wrist exactly on a reachable target, first try', () => {
    const pushed = pushedAt('elbowL', 0, -6, 25);
    const shoulder = seen(pushed, 'shoulderL');
    const want = { px: shoulder.px - 8, py: shoulder.py - 14 };
    const after = seen(resolveDrag(pushed, target('wristL'), want.px, want.py), 'wristL');
    expect(after.px).toBeCloseTo(want.px, 3);
    expect(after.py).toBeCloseTo(want.py, 3);
  });

  it('keeps the deformation — a drag re-poses the rig, it does not undo the push', () => {
    const pushed = pushedAt('elbowL', 0, -6, 25);
    const after = resolveDrag(pushed, target('elbowL'), -30, 70, 0, false);
    expect(after.offsets).toEqual(pushed.offsets);
  });

  it('is the same solve as ever on a rig nobody pushed', () => {
    // No offsets, no split: seat and drawn are the same point, so every
    // unpushed drag answers exactly as it did before this existed.
    const w0 = solveWorld(defaultPose());
    const plain = resolveDrag(defaultPose(), target('elbowL'), w0.shoulderL.x, w0.shoulderL.y - 13.5);
    const empty = resolveDrag(
      { ...defaultPose(), offsets: {} }, target('elbowL'),
      w0.shoulderL.x, w0.shoulderL.y - 13.5,
    );
    expect(poseEquals(plain, empty, 1e-12)).toBe(true);
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
      angles: { elbowL: 0.5, hipL: 3, bogus: 1, elbowR: NaN, wristL: [1, NaN, 0, 0] },
    });
    expect(partial.rootX).toBe(12);
    expect(partial.rootY).toBe(0); // non-finite dropped
    expect(partial.angles.elbowL).toBeDefined();
    // Non-posable (the hip sockets), unknown and non-finite entries never
    // survive.
    expect(partial.angles).not.toHaveProperty('hipL');
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
    // Inside the room the pose leaves (rootLimit); past that it stops at
    // the stage edge rather than carrying the figure out of view.
    const p = resolveDrag(defaultPose(), ROOT_DRAG, 9, 48, 2.4);
    const w = solveWorld(p);
    expect(w.root.x).toBeCloseTo(9, 6);
    expect(w.root.y).toBeCloseTo(48, 6);
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
    const p = resolveDrag(defaultPose(), ROOT_DRAG, 9, 48, TURN);
    const w = solveWorld(p);
    expect(w.root.x).toBeCloseTo(9, 6);
    expect(w.root.y).toBeCloseTo(48, 6);
  });
});

describe('drag-target coverage', () => {
  it('offers the AnimationMentor control set: spine, chest, head, and both full limbs', () => {
    const joints = DRAG_TARGETS.map((t) => t.joint);
    for (const expected of [
      'spine', 'chest', 'collar', 'head',
      'shoulderL', 'elbowL', 'wristL', 'shoulderR', 'elbowR', 'wristR',
      'kneeL', 'ankleL', 'kneeR', 'ankleR',
    ]) {
      expect(joints).toContain(expected);
    }
  });

  it('offers no handle on the root — the figure is grabbed by its joints', () => {
    // The root's knob is the biggest on the figure and sits on the hips,
    // so it took the commonest press in the middle of a rig and carried
    // the whole thing off instead of posing it. Moving a rig around the
    // page is what dragging the OBJECT does.
    expect(DRAG_TARGETS.map((t) => t.joint)).not.toContain('root');
    expect(dragTargetFor('root')).toBeUndefined();
    expect(DRAG_TARGETS.some((t) => t.kind === 'translate')).toBe(false);
  });

  it('reaches ends by IK and mid-joints by FK', () => {
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

describe('the figure never leaves its viewport', () => {
  it('holds for the extreme poses a finger can reach', () => {
    // Arms straight up, arms straight down, legs kicked out, everything
    // dragged as far as the pointer can ask — the stage holds it all,
    // because the stage IS the reach.
    const far = 10_000;
    let pose = defaultPose();
    for (const [joint, x, y] of [
      ['wristL', -far, far], ['wristR', far, far],
      ['ankleL', -far, far], ['ankleR', far, -far],
      ['elbowL', -far, -far], ['head', far, far],
    ] as const) {
      pose = resolveDrag(pose, target(joint), x, y);
      expectInsideStage(pose);
    }
    // …and then dragged bodily as far as the finger goes.
    expectInsideStage(resolveDrag(pose, ROOT_DRAG, far, far));
    expectInsideStage(resolveDrag(pose, ROOT_DRAG, -far, -far));
  });

  it('sizes the stage by the longest chain, the flesh on its end, and the push room', () => {
    // A fingertip on a fully extended arm is the farthest POSING gets from
    // the root; the stage is that, plus the room a deformation is pushed
    // into, squared about the root. Without the second term a fully
    // extended limb sits exactly on the wall and the push brush has
    // nothing to spend there (see PUSH_ROOM).
    expect(STAGE_REACH).toBeGreaterThan(MAX_REACH);
    expect(STAGE_REACH - MAX_REACH).toBeCloseTo(PUSH_ROOM, 9);
    expect(PUSH_ROOM).toBeCloseTo(RIG_HEIGHT * 0.15, 9);
    expect(STAGE.maxX - STAGE.minX).toBeCloseTo(2 * STAGE_REACH, 9);
    expect(STAGE.maxY - STAGE.minY).toBeCloseTo(2 * STAGE_REACH, 9);
    expect(poseReach(solveWorld(defaultPose()))).toBeLessThan(MAX_REACH);
    // The T-pose leaves real room to move — a stage this size is not the
    // figure's own bbox with the travel squeezed out of it.
    expect(rootLimit(solveWorld(defaultPose()))).toBeGreaterThan(10);
  });

  it('leaves a stored pose from a smaller stage where it was', () => {
    // Sanitizing clamps only at the stage's own half-width, so reopening a
    // page never nudges a figure someone posed under an older, tighter
    // rule; the next drag reels it in.
    const legacy = sanitizePose({ v: 2, rootX: 55, rootY: -50, angles: {} });
    expect(legacy.rootX).toBe(55);
    expect(legacy.rootY).toBe(-50);
    expect(sanitizePose({ v: 2, rootX: 9e9, rootY: -9e9, angles: {} }).rootX)
      .toBe(STAGE_REACH);
  });
});
