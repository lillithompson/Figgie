// The PUSH brush: a screen-space deformer for the rig.
//
// Every other way of re-posing a Figgie rotates a bone about its parent —
// grab a knob and the joint orbits. The push brush is the one gesture that
// MOVES joints: drag a soft circle across the figure and each joint under
// it travels with the finger, hardest at the middle of the brush and not
// at all at its rim, so bones stretch, shoulders drop and a silhouette
// smears the way a lump of clay would. It is the deformation the pose
// model's rotations cannot express, which is why it needed a new field to
// write into (FiggiePose.offsets — read its doc first; the not-inherited
// STORAGE rule is what makes a falloff mean anything here).
//
// THE BRUSH MOVES WHAT IT TOUCHES, AND WHATEVER HANGS OFF WHAT IT TOUCHED
// COMES WITH IT. A joint's weight is its own falloff OR its parent's
// effective weight, whichever is larger, so nothing downstream of a shove
// is ever left behind: brush the knee and the shin lengthens while the
// foot rides down whole, brush a wrist and the hand goes with it. Without
// that floor a foot half-outside the circle would lag behind the ankle
// that carries it and the figure would come apart at its own joints —
// bones are drawn between joints and stretch, but the flesh hung ON a
// joint (a foot's boxes, a palm's plate) has only that joint to follow.
//
// AND IT SMEARS. Every drawn bone spans two joints and every drawn solid
// is skinned across the joints it spans, so pushing a fingertip while its
// knuckle stays put BENDS the finger, pushing a heel away from its ball
// stretches the sole, and a brush laid across the hand carries its joints
// by the amount each is under — which is the whole point of a deformer.
// Nothing has to be zoomed in to do it: what separates one joint from its
// neighbour is the brush's own size, and the smallest brush is a fraction
// of a finger.
//
// The one exception is a joint with NO bone back to its parent: a finger's
// rigid base sitting inside the palm plate, and the palm's own pin behind
// the wrist's circle. Those few pairs are drawn as one piece and have to
// move as one, so each takes the strongest share anywhere in it and is
// stage-clamped once for all of it (see GLUED_PAIRS). They span about two
// rig units — nothing a stroke can tell apart.
//
// THE BRUSH ALWAYS HAS SOMEWHERE TO PUSH. Two things make sure of it. The
// stage keeps room past the skeleton's own reach (`PUSH_ROOM`), because
// sized to the reach exactly it left a raised hand or an extended foot —
// the ones at the end of the longest chains — no room at all. And a piece
// that does reach the edge SLIDES along it under the finger rather than
// stopping dead (`assemblySlide`).
//
// The taper still does the work that matters. It shapes the UPSTREAM
// transition — the shoulder near the rim moving a little where the elbow
// at the centre moves fully, so the upper arm bends smoothly out of the
// still body — and it is continuous at the rim, where a joint's own weight
// falls to zero and it simply rides its parent, exactly as a joint just
// outside the circle does.
//
// Everything is defined in the VIEW plane, exactly like `resolveDrag`: the
// brush's centre, its radius and the finger's travel are all in the turned
// orthographic frame the figure is seen in, and the displacement is that
// flat push pulled back into rig space. So the same gesture deforms in the
// direction it looks like it should from any turn, and a quarter-turn +
// push builds depth out of nothing but flat strokes.
//
// Pure math, no canvas — the whole brush is node-testable.

import { FiggiePose, WorldJoints, solveWorld } from './pose';
import {
  JointId, SKELETON, STAGE_REACH, assemblyMembers, assemblyOf, jointBound,
} from './skeleton';
import { quatInv, quatRotate } from './quat';
import { TurnLike, projectTurn, turnQuat } from './view';

/**
 * Sharpness of the brush's bell. `exp(-K·t²)` with K = 4 has fallen to
 * ~2% by the rim, which the shift below takes the rest of the way to
 * exactly nothing: full force at the centre, none at all at the edge, and
 * no step at the boundary where a truncated gaussian would leave one.
 */
export const PUSH_FALLOFF_K = 4;

/** The brush's weight at `t` = distance / radius. 1 at the centre, 0 at
 *  (and past) the rim, smooth in between. */
export function pushFalloff(t: number): number {
  if (!(t > 0)) return 1;
  if (t >= 1) return 0;
  const rim = Math.exp(-PUSH_FALLOFF_K);
  return (Math.exp(-PUSH_FALLOFF_K * t * t) - rim) / (1 - rim);
}

/**
 * How much of a displacement `(dx, dy, dz)` a point at `(cx, cy, cz)` — read
 * from the root — can take before it leaves the ball of radius `allowed`
 * around it: the largest `t` in [0, 1] with `|c + t·d| ≤ allowed`.
 *
 * Used as the guaranteed-feasible backstop under {@link assemblySlide}:
 * scaling ONE displacement down by the smallest such `t` over an
 * assembly's joints keeps every one of them inside its own ball, whatever
 * the slide arrived at.
 *
 * A point already outside its ball keeps whatever room it has: the limit
 * becomes the distance it is at, so it can travel sideways or inward but
 * never further out. (Nothing normally is — this is for a pose loaded from
 * a file, or one whose bounds moved under it.)
 */
function travelFraction(
  cx: number, cy: number, cz: number,
  dx: number, dy: number, dz: number,
  allowed: number,
): number {
  const dd = dx * dx + dy * dy + dz * dz;
  if (!(dd > 0)) return 1;
  const cc = cx * cx + cy * cy + cz * cz;
  const rr = Math.max(allowed * allowed, cc);
  const cd = cx * dx + cy * dy + cz * dz;
  // cc ≤ rr by construction, so the discriminant is ≥ cd² and the larger
  // root is the one at or past 0.
  const t = (-cd + Math.sqrt(cd * cd - dd * (cc - rr))) / dd;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** How many times {@link assemblySlide} sweeps its joints. Each sweep
 *  seats the piece exactly against whichever ball it has left, so ONE
 *  binding joint is answered by the first pass and the handful that can
 *  bind at once settle in a few more. Four is well past what a hand or a
 *  foot needs, and it is ~90 flops on a path that runs once per assembly
 *  per dab. */
const SLIDE_PASSES = 4;

/**
 * The ONE displacement a RIGID assembly may wear: the brush's push, pulled
 * back inside the ball each of its joints is allowed — by SLIDING the whole
 * piece along whichever boundary it meets, not by stopping it dead there.
 *
 * Sliding is what a lone joint has always done at the edge of the stage,
 * and doing anything else to a hand or a foot is what made the brush feel
 * broken. A rigid piece takes one travel for all of it, so the smallest
 * travel any of its joints allows used to be the travel — and a fingertip
 * or a toe, at the end of the longest chain in the figure, is the joint
 * with the least room in it. One pinned fingertip stopped all twenty-three
 * joints of the hand behind it, in every direction at once, however hard
 * the finger shoved. That is the "push does not affect the fingers or
 * feet" report: not a missing share, a share with nowhere to go.
 *
 * Each pass pulls the piece back onto the sphere of any joint that has
 * left its ball — an alternating projection onto convex sets, which
 * converges into the intersection of them all — so the assembly ends up
 * gliding ALONG the stage boundary under the finger instead of freezing
 * against it, still one rigid translation (every joint wears exactly this,
 * so nothing inside can come apart).
 *
 * The travelFraction pass at the end is the guarantee, not the algorithm:
 * whatever the sweeps reached, scaling it by the least travel every joint
 * allows lands inside every ball, so the stage's promise holds even if the
 * passes ran out. Well inside the intersection that factor is 1 and the
 * slide is what it says.
 */
function assemblySlide(
  members: readonly JointId[],
  world: WorldJoints,
  rootX: number, rootY: number, rootZ: number,
  dx: number, dy: number, dz: number,
  room: (id: JointId) => number,
): [number, number, number] {
  let ax = dx;
  let ay = dy;
  let az = dz;
  for (let pass = 0; pass < SLIDE_PASSES; pass++) {
    let slid = false;
    for (const id of members) {
      const j = world[id];
      const cx = j.x - rootX;
      const cy = j.y - rootY;
      const cz = j.z - rootZ;
      // A joint already outside its ball keeps the room it has, exactly as
      // travelFraction reads it — it may slide, never bulge further out.
      const allowed = Math.max(room(id), Math.hypot(cx, cy, cz));
      const nx = cx + ax;
      const ny = cy + ay;
      const nz = cz + az;
      const len = Math.hypot(nx, ny, nz);
      if (!(len > allowed + 1e-9)) continue;
      const s = allowed / len;
      ax = nx * s - cx;
      ay = ny * s - cy;
      az = nz * s - cz;
      slid = true;
    }
    if (!slid) break;
  }
  let t = 1;
  for (const id of members) {
    const j = world[id];
    t = Math.min(t, travelFraction(
      j.x - rootX, j.y - rootY, j.z - rootZ, ax, ay, az, room(id),
    ));
    if (t <= 0) break;
  }
  return [ax * t, ay * t, az * t];
}

/**
 * One dab of the push brush: every joint whose projection falls inside the
 * circle of `radius` about (`viewX`, `viewY`) is displaced by the view
 * travel (`dViewX`, `dViewY`) scaled by {@link pushFalloff} — or by its
 * parent's share, if that is larger, which is what keeps the figure in one
 * piece (see the module header). Coordinates and radius are VIEW units —
 * what `projectTurn` emits and what `resolveDrag` already takes.
 *
 * A drag is a run of these, each carrying the delta since the last move,
 * so the deformation accumulates under a moving brush exactly as a paint
 * stroke's colour does.
 *
 * The ROOT is never displaced, and nothing inherits a share from it. It is
 * the figure's anchor rather than part of its shape: the view pivots on
 * it, the stage is measured from it, and moving the whole figure is
 * already what dragging the body (or its root knob) does. Leaving it out
 * keeps the pivot still under the brush and keeps one invariant simple —
 * every displaced joint is clamped into the ball the STAGE guarantees to
 * frame (`STAGE_REACH`, less the flesh drawn past the joint and less
 * however far the root has already wandered), so no amount of pushing can
 * smear the figure out through its own viewport. (The pelvis it carries is drawn
 * skinned to the hips, so the legs take their share of it with them rather
 * than pulling out of a shield nailed to a joint the brush cannot move.)
 *
 * Returns a NEW pose; the input is never mutated. Returns it unchanged
 * when the dab moves nothing.
 */
export function pushPose(
  pose: FiggiePose,
  turn: TurnLike,
  viewX: number,
  viewY: number,
  dViewX: number,
  dViewY: number,
  radius: number,
): FiggiePose {
  if (!(radius > 0)) return pose;
  if (!Number.isFinite(dViewX) || !Number.isFinite(dViewY)) return pose;
  if (!Number.isFinite(viewX) || !Number.isFinite(viewY)) return pose;
  if (!(Math.hypot(dViewX, dViewY) > 1e-9)) return pose;

  const world = solveWorld(pose);
  const q = turnQuat(turn);
  const qi = quatInv(q);
  const root = world.root;
  // How far the figure has already been walked from rest: the stage is
  // centred on the REST root, so that travel is room the deformation no
  // longer has (the same budget `rootLimit` splits the other way).
  const rootTravel = Math.hypot(pose.rootX, pose.rootY);

  const offsets: Partial<Record<JointId, [number, number, number]>> = { ...(pose.offsets ?? {}) };

  // PASS 1 — each joint's own falloff, and the strongest one anywhere in
  // each rigid group. Almost every joint keeps its own share, which is
  // what makes the brush smear; only the few pairs with no bone between
  // them (a finger's base inside the palm plate, the palm's pin behind the
  // wrist) take one share for all of them, or the piece tears (see
  // GLUED_PAIRS).
  const own = {} as Record<JointId, number>;
  const assemblyShare = new Map<JointId, number>();
  for (const joint of SKELETON) {
    const id = joint.id;
    if (!joint.parent) { own[id] = 0; continue; }
    const j = world[id];
    const p = projectTurn(j.x, j.y, j.z, q, root.x, root.y);
    const w = pushFalloff(Math.hypot(p.px - viewX, p.py - viewY) / radius);
    own[id] = w;
    const a = assemblyOf(id);
    if (a) assemblyShare.set(a, Math.max(assemblyShare.get(a) ?? 0, w));
  }

  // Each joint's SHARE of the push. SKELETON lists parents before children,
  // so one walk both reads a parent's share and writes the child's.
  const share = {} as Record<JointId, number>;
  // One clamped displacement per assembly, computed at its root and worn by
  // every joint in it — the second half of moving as one piece.
  const assemblyPush = new Map<JointId, [number, number, number]>();
  let moved = false;
  for (const joint of SKELETON) {
    const id = joint.id;
    if (!joint.parent) {
      // The anchor, not the shape — and nothing hangs off it, so the whole
      // figure is not dragged along by a brush that grazed the pelvis.
      share[id] = 0;
      continue;
    }
    const a = assemblyOf(id);
    // Its own falloff (or its whole assembly's), and never less than its
    // parent's share: what the brush moves takes everything hanging off it
    // along. Inside an assembly this settles to one value — the members'
    // parents are members, already carrying it.
    const w = Math.max(a ? assemblyShare.get(a)! : own[id], share[joint.parent]);
    share[id] = w;
    if (w <= 0) continue;
    const j = world[id];
    let ax: number;
    let ay: number;
    let az: number;
    const held = a && a !== id ? assemblyPush.get(a) : undefined;
    if (held) {
      // A member of an assembly already clamped at its root: wear exactly
      // what the root wore. Nothing is measured per joint here — that is
      // what would pull the hand apart.
      [ax, ay, az] = held;
    } else {
      // The flat push, pulled back through the turn: a shove that reads as
      // "left" on screen is a shove to the left of the VIEWER, whatever the
      // figure is turned to.
      const [wx, wy, wz] = quatRotate(qi, dViewX * w, dViewY * w, 0);
      const room = (of: JointId) =>
        Math.max(0, STAGE_REACH - rootTravel - jointBound(of));
      if (a === id) {
        // An assembly is clamped ONCE, for all of it — one travel for the
        // whole hand or foot, so it arrives in one piece however hard the
        // brush shoves — and it SLIDES along the stage rather than
        // stopping at it, the same as a lone joint (see assemblySlide).
        [ax, ay, az] = assemblySlide(
          assemblyMembers(a), world, root.x, root.y, root.z, wx, wy, wz, room,
        );
        assemblyPush.set(a, [ax, ay, az]);
      } else {
        let nx = j.x + wx;
        let ny = j.y + wy;
        let nz = j.z + wz;
        const allowed = room(id);
        const reach = Math.hypot(nx - root.x, ny - root.y, nz - root.z);
        if (reach > allowed) {
          // A joint on its own slides along the boundary rather than
          // stopping dead at it — the same feel the root drag has when it
          // runs out of stage.
          const s = allowed / reach;
          nx = root.x + (nx - root.x) * s;
          ny = root.y + (ny - root.y) * s;
          nz = root.z + (nz - root.z) * s;
        }
        ax = nx - j.x;
        ay = ny - j.y;
        az = nz - j.z;
      }
    }
    if (!(Math.hypot(ax, ay, az) > 1e-9)) continue; // already against the rim
    // Stored in the joint's own posed frame, so the displacement swings
    // with the limb when the pose changes later.
    const [lx, ly, lz] = quatRotate(quatInv(j.rot), ax, ay, az);
    const prev = offsets[id] ?? [0, 0, 0];
    const next: [number, number, number] = [prev[0] + lx, prev[1] + ly, prev[2] + lz];
    if (Math.hypot(next[0], next[1], next[2]) > 1e-6) offsets[id] = next;
    else delete offsets[id];
    moved = true;
  }
  if (!moved) return pose;

  const out: FiggiePose = { ...pose, angles: { ...pose.angles } };
  // An undeformed pose carries no field at all — that is what every pose
  // saved before the brush existed looks like, and what a push undone back
  // to nothing must look like again.
  if (Object.keys(offsets).length > 0) out.offsets = offsets;
  else delete out.offsets;
  return out;
}
