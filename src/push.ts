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

import { FiggiePose, solveWorld } from './pose';
import { JointId, MAX_REACH, SKELETON, jointBound } from './skeleton';
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
 * frame (`MAX_REACH`, less the flesh drawn past the joint and less however
 * far the root has already wandered), so no amount of pushing can smear
 * the figure out through its own viewport. (The pelvis it carries is drawn
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
  // Each joint's SHARE of the push. SKELETON lists parents before children,
  // so one walk both reads a parent's share and writes the child's.
  const share = {} as Record<JointId, number>;
  let moved = false;
  for (const joint of SKELETON) {
    const id = joint.id;
    if (!joint.parent) {
      // The anchor, not the shape — and nothing hangs off it, so the whole
      // figure is not dragged along by a brush that grazed the pelvis.
      share[id] = 0;
      continue;
    }
    const j = world[id];
    const p = projectTurn(j.x, j.y, j.z, q, root.x, root.y);
    // Its own falloff, or its parent's share if that is larger: what the
    // brush moves takes everything hanging off it along.
    const w = Math.max(
      pushFalloff(Math.hypot(p.px - viewX, p.py - viewY) / radius),
      share[joint.parent],
    );
    share[id] = w;
    if (w <= 0) continue;
    // The flat push, pulled back through the turn: a shove that reads as
    // "left" on screen is a shove to the left of the VIEWER, whatever the
    // figure is turned to.
    const [wx, wy, wz] = quatRotate(qi, dViewX * w, dViewY * w, 0);
    let nx = j.x + wx;
    let ny = j.y + wy;
    let nz = j.z + wz;
    const allowed = Math.max(0, MAX_REACH - rootTravel - jointBound(id));
    const reach = Math.hypot(nx - root.x, ny - root.y, nz - root.z);
    if (reach > allowed) {
      // Slide along the boundary rather than stopping dead at it — the
      // same feel the root drag has when it runs out of stage.
      const s = allowed / reach;
      nx = root.x + (nx - root.x) * s;
      ny = root.y + (ny - root.y) * s;
      nz = root.z + (nz - root.z) * s;
    }
    const ax = nx - j.x;
    const ay = ny - j.y;
    const az = nz - j.z;
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
