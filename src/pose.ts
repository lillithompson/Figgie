// Figgie's pose model: one ROTATION per posable bone (a quaternion), FK
// down the hierarchy, and the drag behaviours that re-pose it. Pure math —
// no canvas, no time, no randomness — so the whole posing contract is
// node-testable.
//
// THE ONE INTERACTION RULE: a drag always rotates about the axis NORMAL TO
// THE VIEWPORT. Grab an elbow and the upper arm swings on a circle lying
// in the view plane — the joint orbits its parent at a constant apparent
// radius, tracking the finger's angle exactly. Because the yaw slider
// changes which world axis that is, turning the figure and dragging builds
// genuinely three-dimensional poses out of nothing but flat, screen-plane
// gestures: face front and swing an arm sideways, quarter-turn and swing
// the same arm forward.
//
// A pose is a small, JSON-serializable object: root offset + per-bone unit
// quats, keyed by the joint the bone ends at, composing down the chain so
// bending the spine carries chest, arms and head — "moving the joint
// hierarchy". Poses saved by the older planar model (one angle per bone,
// about z) load losslessly: a number is the same rotation written smaller.

import {
  DragTarget, JOINT_IDS, JointId, MAX_REACH, SKELETON, RIG_HEIGHT, dragTargetFor, jointBound,
  restJoint,
} from './skeleton';
import {
  Quat, QUAT_IDENTITY, quatEquals, quatFromAxisAngle, quatInv, quatIsIdentity,
  quatMul, quatNormalize, quatRotate,
} from './quat';
import { TurnLike, projectTurn, turnQuat } from './view';

export interface FiggiePose {
  /** Format version. v1 stored planar angles (radians about z) in `angles`;
   *  v2 stores quats there. `sanitizePose` reads both. */
  v: 1 | 2;
  /** Root (pelvis) offset from its rest position, rig units. */
  rootX: number;
  rootY: number;
  /** Per-bone rotations (unit quats, delta from rest), keyed by the joint
   *  the bone ends at. Missing = identity. Only posable joints are
   *  meaningful. */
  angles: Partial<Record<JointId, Quat>>;
}

/** The rest (T) pose. */
export function defaultPose(): FiggiePose {
  return { v: 2, rootX: 0, rootY: 0, angles: {} };
}

/**
 * How far THIS pose's drawing reaches from its root, rig units — the
 * radius of a ball about the root that holds every drawn point (3D, so it
 * holds under every turn as well).
 */
export function poseReach(world: WorldJoints): number {
  const r = world.root;
  let max = 0;
  for (const id of JOINT_IDS) {
    const j = world[id];
    max = Math.max(max, Math.hypot(j.x - r.x, j.y - r.y, j.z - r.z) + jointBound(id));
  }
  return max;
}

/**
 * How far the root may wander from rest, rig units: whatever the stage
 * has left over once this pose's own reach is taken out.
 *
 * So the figure is never draggable partway out of its viewport, and a
 * pose that spreads wide (arms out) simply has less room to travel than a
 * compact one — the same rule the stage is sized by, read the other way
 * round. Symmetric in x and y because the stage is a square centred on
 * the rest root, and turn-independent because the reach is 3D.
 */
export function rootLimit(world: WorldJoints): number {
  return Math.max(0, MAX_REACH - poseReach(world));
}

/** A hard ceiling on a PARSED root offset (sanitizePose): the stage's own
 *  half-width, so no stored number can seat a figure a whole stage away.
 *  Deliberately looser than {@link rootLimit} — clamping a saved pose
 *  tight would move figures posed under an older, smaller stage; the next
 *  drag reels them in instead. */
const ROOT_PARSE_LIMIT = MAX_REACH;

const TAU = Math.PI * 2;

/** Normalize to (-π, π]. */
export function normalizeAngle(a: number): number {
  let r = a % TAU;
  if (r > Math.PI) r -= TAU;
  if (r <= -Math.PI) r += TAU;
  return r;
}

// ── Forward kinematics ──────────────────────────────────────────────

export interface WorldJoint {
  x: number;
  y: number;
  z: number;
  /** Accumulated rotation at this joint (what a child bone composes onto). */
  rot: Quat;
}

export type WorldJoints = Record<JointId, WorldJoint>;

/**
 * Solve every joint's world position + accumulated rotation for `pose`.
 * One forward walk — SKELETON lists parents before children. Bones posed
 * out of the rig plane carry real z, which is what makes the yawed views
 * read as a figure and not a cutout.
 */
export function solveWorld(pose: FiggiePose): WorldJoints {
  const out = {} as WorldJoints;
  for (const j of SKELETON) {
    if (!j.parent) {
      // The root's own rotation turns the whole figure: it is the frame
      // every other bone composes onto (rotateRig writes it).
      out[j.id] = {
        x: j.dx + pose.rootX,
        y: j.dy + pose.rootY,
        z: j.dz,
        rot: pose.angles[j.id] ?? QUAT_IDENTITY,
      };
      continue;
    }
    const p = out[j.parent];
    const local = j.posable ? pose.angles[j.id] : undefined;
    const rot = local ? quatMul(p.rot, local) : p.rot;
    const [ox, oy, oz] = quatRotate(rot, j.dx, j.dy, j.dz);
    out[j.id] = { x: p.x + ox, y: p.y + oy, z: p.z + oz, rot };
  }
  return out;
}

/** The world-space axis normal to the viewport under `turn` — the ONE axis
 *  every drag rotates about: the view rotation's pullback of ẑ. For the
 *  classic yaw it is (-sin yaw, 0, cos yaw) — e1 × e2 of the projected
 *  screen basis — so a positive rotation about it moves a projected point
 *  counter-clockwise in view coordinates, the same convention atan2
 *  reads; a general in-plane turn axis tilts it identically. */
export function viewAxis(turn: TurnLike): [number, number, number] {
  return quatRotate(quatInv(turnQuat(turn)), 0, 0, 1);
}

// ── Drag resolution ─────────────────────────────────────────────────

/** Below this apparent radius (rig units) a bone is edge-on to the view —
 *  its projected direction is noise, so rotating it from a drag would
 *  spin wildly. The drag no-ops; a small turn of the yaw slider brings
 *  the bone back into a poseable plane. */
const MIN_APPARENT_RADIUS = 0.75;

/**
 * Re-pose so the dragged joint tracks the finger. `viewX/viewY` are the
 * pointer in VIEW coordinates — the turned orthographic frame the figure
 * is seen in (rig units, y up, pivoted on the root; exactly what
 * projectTurn emits) — because the whole interaction is defined in that
 * plane:
 *
 *  - translate (root): the root IS the turn pivot, so its projection is
 *    its rig position — the figure follows the finger exactly under any
 *    turn, clamped so the figure stays inside the stage (rootLimit).
 *  - fk: the bone ending at the joint rotates about the VIEW AXIS so the
 *    joint's projection matches the finger's angle around its parent; its
 *    apparent radius is preserved (the orbit is a circle in the view
 *    plane). Everything downstream rides along rigidly.
 *  - ik2 (wrists, ankles): planar 2-bone IK in the view plane on the
 *    chain's APPARENT (projected) lengths, then each bone rotates about
 *    the view axis onto its solution — the end lands under the finger
 *    when the projected reach allows, the current bend side is kept, and
 *    whatever depth the chain held is preserved.
 *
 * `ik = false` (a host's IK toggle) poses a chain end as plain FK instead:
 * the end bone swings about its parent — the elbow / knee stays nailed in
 * place, as does every other joint — so only the grabbed wrist or ankle
 * moves. The rotation is still about the view axis, exactly like every
 * other drag. FK and translate targets ignore the flag.
 *
 * Returns a NEW pose; the input is never mutated.
 */
export function resolveDrag(
  pose: FiggiePose,
  target: DragTarget,
  viewX: number,
  viewY: number,
  turn: TurnLike = 0,
  ik = true,
): FiggiePose {
  if (target.kind === 'translate') {
    const rest = restJoint('root');
    // The figure travels as one rigid thing, so the room it has is the
    // stage minus its own reach — it slides along the boundary rather
    // than walking off it.
    const limit = rootLimit(solveWorld(pose));
    return {
      ...pose,
      rootX: clamp(viewX - rest.dx, -limit, limit),
      rootY: clamp(viewY - rest.dy, -limit, limit),
      angles: { ...pose.angles },
    };
  }

  const world = solveWorld(pose);
  const q = turnQuat(turn);
  const pivotX = world.root.x;
  const pivotY = world.root.y;
  const [nx, ny, nz] = quatRotate(quatInv(q), 0, 0, 1);
  const proj = (j: WorldJoint) => projectTurn(j.x, j.y, j.z, q, pivotX, pivotY);

  // With IK off, a chain end (wrist / ankle) IS an FK joint: the bone
  // ending at it rotates about its parent (the elbow / knee, which does
  // not move), the same rule every mid-chain joint follows.
  if (target.kind === 'fk' || !ik) {
    const joint = restJoint(target.joint);
    const parent = world[joint.parent!];
    const pp = proj(parent);
    const jp = proj(world[target.joint]);
    const r = Math.hypot(jp.px - pp.px, jp.py - pp.py);
    if (r < MIN_APPARENT_RADIUS) return pose; // edge-on — see the constant
    if (Math.hypot(viewX - pp.px, viewY - pp.py) < 1e-6) return pose;
    const alpha = Math.atan2(viewY - pp.py, viewX - pp.px)
      - Math.atan2(jp.py - pp.py, jp.px - pp.px);
    return {
      ...pose,
      angles: {
        ...pose.angles,
        [target.joint]: rotatedLocal(world, target.joint, alpha, nx, ny, nz),
      },
    };
  }

  // ik2 — chain = [mid, end]; root of the chain is the mid bone's parent.
  const [midId, endId] = target.chain!;
  const chainRootId = restJoint(midId).parent!;
  const S = world[chainRootId];
  const sp = proj(S);
  const mp = proj(world[midId]);
  const ep = proj(world[endId]);

  // APPARENT lengths: what the bones measure on screen right now. A chain
  // angled into the screen reaches a shorter way across the view plane —
  // and rotating about the view axis preserves exactly these radii.
  const a = Math.hypot(mp.px - sp.px, mp.py - sp.py);
  const b = Math.hypot(ep.px - mp.px, ep.py - mp.py);
  if (a < MIN_APPARENT_RADIUS || b < MIN_APPARENT_RADIUS) return pose;

  let vx = viewX - sp.px;
  let vy = viewY - sp.py;
  let d = Math.hypot(vx, vy);
  if (d < 1e-6) {
    vx = ep.px - sp.px;
    vy = ep.py - sp.py;
    d = Math.max(Math.hypot(vx, vy), 1e-6);
  }
  const reach = clamp(d, Math.abs(a - b) + 1e-4, a + b - 1e-4);

  // Keep the current bend side (projected); a dead-straight chain picks
  // the side that reads as a natural elbow/knee for that limb.
  const cross = (mp.px - sp.px) * (ep.py - sp.py) - (mp.py - sp.py) * (ep.px - sp.px);
  const bend = Math.abs(cross) > 1e-4 ? Math.sign(cross) : defaultBendSign(endId);

  const phi = Math.atan2(vy, vx);
  const alphaIk = Math.acos(clamp((a * a + reach * reach - b * b) / (2 * a * reach), -1, 1));
  const theta1 = phi - bend * alphaIk;
  const mx = sp.px + a * Math.cos(theta1);
  const my = sp.py + a * Math.sin(theta1);
  const tx = sp.px + vx * (reach / d);
  const ty = sp.py + vy * (reach / d);

  // Two view-axis rotations, applied in chain order (the end bone's
  // rotation is computed against the mid's NEW projection).
  const alphaMid = Math.atan2(my - sp.py, mx - sp.px)
    - Math.atan2(mp.py - sp.py, mp.px - sp.px);
  const midLocal = rotatedLocal(world, midId, alphaMid, nx, ny, nz);
  const mid = { ...pose, angles: { ...pose.angles, [midId]: midLocal } };
  const worldMid = solveWorld(mid);
  const mp2 = proj(worldMid[midId]);
  const ep2 = proj(worldMid[endId]);
  const alphaEnd = Math.atan2(ty - mp2.py, tx - mp2.px)
    - Math.atan2(ep2.py - mp2.py, ep2.px - mp2.px);
  return {
    ...mid,
    angles: {
      ...mid.angles,
      [endId]: rotatedLocal(worldMid, endId, alphaEnd, nx, ny, nz),
    },
  };
}

/** The bone-ending-at-`id`'s new LOCAL quat after a world rotation of
 *  `alpha` about the view axis: local' = parentRot⁻¹ · R(n, α) · worldRot. */
function rotatedLocal(
  world: WorldJoints,
  id: JointId,
  alpha: number,
  nx: number, ny: number, nz: number,
): Quat {
  const parent = world[restJoint(id).parent!];
  const worldRot = world[id].rot;
  const turned = quatMul(quatFromAxisAngle(nx, ny, nz, alpha), worldRot);
  return quatNormalize(quatMul(quatInv(parent.rot), turned));
}

/** Which way a dead-straight limb folds when IK first bends it — per
 *  side, so elbows, knees and toes break the way a mannequin's joints
 *  suggest. */
function defaultBendSign(endId: JointId): number {
  switch (endId) {
    case 'wristL': return 1;
    case 'wristR': return -1;
    case 'ankleL': return -1;
    case 'ankleR': return 1;
    case 'toeL': return -1;
    case 'toeR': return 1;
    default: return 1;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// ── Serialization ───────────────────────────────────────────────────

/**
 * Coerce anything (a parsed JSON blob, an older planar pose, garbage) into
 * a valid pose: unknown joints dropped, non-finite values zeroed, quats
 * normalized, identity rotations elided, root clamped. A v1 planar angle
 * (a plain number, radians about z) converts to the identical rotation as
 * a quat, so every pose ever saved re-poses losslessly.
 */
export function sanitizePose(raw: unknown): FiggiePose {
  const pose = defaultPose();
  if (typeof raw !== 'object' || raw === null) return pose;
  const r = raw as Record<string, unknown>;
  if (typeof r.rootX === 'number' && Number.isFinite(r.rootX)) {
    pose.rootX = clamp(r.rootX, -ROOT_PARSE_LIMIT, ROOT_PARSE_LIMIT);
  }
  if (typeof r.rootY === 'number' && Number.isFinite(r.rootY)) {
    pose.rootY = clamp(r.rootY, -ROOT_PARSE_LIMIT, ROOT_PARSE_LIMIT);
  }
  if (typeof r.angles === 'object' && r.angles !== null) {
    for (const [key, value] of Object.entries(r.angles as Record<string, unknown>)) {
      const joint = SKELETON.find((j) => j.id === key);
      if (!joint || !joint.posable) continue;
      const quat = coerceRotation(value);
      if (quat && !quatIsIdentity(quat)) pose.angles[joint.id] = quat;
    }
  }
  return pose;
}

function coerceRotation(value: unknown): Quat | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    // v1 planar angle: the same rotation, about z.
    return quatFromAxisAngle(0, 0, 1, normalizeAngle(value));
  }
  if (Array.isArray(value) && value.length === 4
    && value.every((c) => typeof c === 'number' && Number.isFinite(c))) {
    const len = Math.hypot(value[0], value[1], value[2], value[3]);
    if (!(len > 1e-6)) return null;
    return quatNormalize([value[0], value[1], value[2], value[3]]);
  }
  return null;
}

/** Whether two poses read as the same figure — what "has the player
 *  actually posed anything?" asks. */
export function poseEquals(a: FiggiePose, b: FiggiePose, eps = 1e-3): boolean {
  if (Math.abs(a.rootX - b.rootX) > eps || Math.abs(a.rootY - b.rootY) > eps) return false;
  for (const j of SKELETON) {
    if (!j.posable) continue;
    const qa = a.angles[j.id] ?? QUAT_IDENTITY;
    const qb = b.angles[j.id] ?? QUAT_IDENTITY;
    if (!quatEquals(qa, qb, eps)) return false;
  }
  return true;
}

export { dragTargetFor, RIG_HEIGHT };
