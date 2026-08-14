// POSTURE SHAPERS: named, whole-part poses a host can drive from a single
// slider — curl a hand into a fist, point or flatten a foot, bend / twist /
// lean the spine.
//
// Every shaper is ABSOLUTE, not a delta: it writes the joints it owns
// straight from its parameter and leaves every other joint alone. That is
// what lets a slider drive one: dragging it repeatedly re-derives the same
// joints instead of compounding, and two shapers never fight because their
// joint sets are disjoint (one hand, one foot, the spine column). Identity
// results are ELIDED rather than stored, so a shaper at rest leaves a pose
// byte-identical to one that was never shaped — which is what keeps a
// "nothing changed" commit from building an undo entry.
//
// The host decides WHEN to apply one. Figgie deliberately offers no way to
// read a slider position back out of a pose: a hand posed finger by finger
// has no single "fistness", so a host shows its sliders at rest and only
// touches the pose once the user moves one.

import { FiggiePose } from './pose';
import { FINGER_NAMES, FOOT_SPLAY, JointId } from './skeleton';
import { Quat, quatFromAxisAngle, quatMul, quatNormalize } from './quat';

export type Side = 'L' | 'R';

/** How far a spine slider can carry the column, radians end to end (the
 *  total is shared out along {@link SPINE_COLUMN}). The bend reaches far
 *  enough to curl the figure right over — a deep stoop, not a polite nod —
 *  because it arrives spread along the whole column rather than as a hinge
 *  at one joint. */
export const SPINE_RANGE = { bend: 2, twist: 0.8, lean: 0.6 };

/** The column the spine sliders bend, stomach → head, and each joint's
 *  SHARE of the total (summing to 1). Every bone from the pelvis up takes
 *  some of the curve — weighted toward the base, the way a spine bends —
 *  so the figure arcs smoothly instead of hinging at one place. The chain
 *  runs all the way through: the collar carries the shoulders round, the
 *  neck and head finish the curve, so a deep bend has the figure looking
 *  down at its own feet rather than staring straight ahead from a folded
 *  body. */
export const SPINE_COLUMN: ReadonlyArray<[JointId, number]> = [
  ['spine', 0.3], ['chest', 0.26], ['collar', 0.19], ['neck', 0.13], ['head', 0.12],
];

/** How far a finger travels closing into a fist, radians from straight to
 *  fully curled. The thumb folds across rather than under, so it turns
 *  through much less. */
export const FIST_RANGE = { finger: 3.5, thumb: 1.5 };
/** The palm cups a little as the fist closes. */
const FIST_PALM = 0.26;

/** The finger's posable segments and each one's SHARE of that travel
 *  (summing to 1). Every knuckle takes a comparable part of the curl —
 *  slightly more at the base, as a finger folds — so the whole finger
 *  arcs into the palm instead of staying straight and hinging at one
 *  joint. (Segment 0 is the rigid base knuckle on the palm rim; the palm
 *  itself cups through its own bend joint.) */
export const FINGER_COLUMN: ReadonlyArray<[1 | 2 | 3, number]> = [
  [1, 0.36], [2, 0.34], [3, 0.3],
];

/** Fully-pointed foot: the ankle extends the foot in line with the shin,
 *  the toe box carrying a little further. */
const POINT_BALL = 0.95;
const POINT_TOE = 0.34;

function clamp01(v: number): number {
  return !Number.isFinite(v) ? 0 : v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Slider 0..1 → −1..1, with the center exactly straight. */
export function centered(v: number): number {
  return clamp01(v) * 2 - 1;
}

type Angles = FiggiePose['angles'];

/** Write one joint's rotation, ELIDING a rotation of nothing — an unshaped
 *  part must leave the pose exactly as it found it. */
function setAngle(angles: Angles, id: JointId, axis: [number, number, number], angle: number): void {
  if (Math.abs(angle) < 1e-6) {
    delete angles[id];
    return;
  }
  angles[id] = quatFromAxisAngle(axis[0], axis[1], axis[2], angle);
}

/**
 * Curl one hand: `t` 0 = flat (every finger straight), 1 = a closed fist.
 * The fingers fold in the rig plane — about the view-normal z at rest —
 * each segment tighter than the last, and the palm cups slightly as it
 * closes. Writes only that hand's finger segments and its palm-bend joint.
 */
export function curlHand(pose: FiggiePose, side: Side, t: number): FiggiePose {
  const k = clamp01(t);
  // Fingers hinge about the KNUCKLE LINE — the axis running across the
  // palm, which for this hand is the rig's up axis (the fan spreads in y,
  // the fingers reach along x, and the palm's flat face looks along z).
  // Turning about it sweeps the tips out of the palm's plane and INTO it,
  // the way a hand closes; turning about z, as this once did, folded them
  // sideways across the palm instead. The two hands reach opposite ways,
  // so the sense of the turn flips per side and both close toward the
  // face they hold up.
  const axis: [number, number, number] = [0, side === 'L' ? 1 : -1, 0];
  const angles: Angles = { ...pose.angles };
  setAngle(angles, `knuck${side}` as JointId, axis, FIST_PALM * k);
  for (const name of FINGER_NAMES) {
    const range = name === 'thumb' ? FIST_RANGE.thumb : FIST_RANGE.finger;
    for (const [seg, share] of FINGER_COLUMN) {
      setAngle(angles, `${name}${side}${seg}` as JointId, axis, range * share * k);
    }
  }
  return { ...pose, angles };
}

/** The horizontal axis a foot pitches about: perpendicular to its own
 *  splayed direction, so a pointed toe swings down its own line rather
 *  than skewing sideways. */
function footAxis(side: Side): [number, number, number] {
  const cos = Math.cos(FOOT_SPLAY);
  const sin = Math.sin(FOOT_SPLAY);
  return [cos, 0, side === 'L' ? sin : -sin];
}

/**
 * Flex one foot: `t` 0 = toes fully pointed (the foot extends in line with
 * the shin), 1 = flat (the sole level, the rest pose). Writes only that
 * foot's ball and toe joints.
 */
export function flexFoot(pose: FiggiePose, side: Side, t: number): FiggiePose {
  const point = 1 - clamp01(t); // 1 = fully pointed
  const axis = footAxis(side);
  const angles: Angles = { ...pose.angles };
  setAngle(angles, `ball${side}` as JointId, axis, POINT_BALL * point);
  setAngle(angles, `toe${side}` as JointId, axis, POINT_TOE * point);
  return { ...pose, angles };
}

/** How far each rig-rotation slider can turn the whole figure, radians
 *  end to end — a half turn each way on every axis, so the mannequin can
 *  be stood in any orientation from three sliders. */
export const RIG_SPIN_RANGE = Math.PI;

export interface RigSpin {
  /** Pitch: tip the whole figure forward (+) or back (−), −1..1. */
  x: number;
  /** Yaw: spin it about its own up axis, −1..1. */
  y: number;
  /** Roll: tip it sideways, −1..1. */
  z: number;
}

/**
 * Turn the WHOLE figure: the root's own rotation, which every other bone
 * composes onto, so the pose underneath is untouched and the mannequin
 * simply stands a different way round.
 *
 * Unlike the host's view Turn — which is a camera move, and which the bake
 * records separately — this is part of the POSE: the figure really is
 * oriented like this, and a drag on any joint still resolves in the view
 * plane against it.
 *
 * Absolute like every other shaper, composed in the fixed order roll →
 * pitch → yaw, and writing exactly one joint.
 */
export function rotateRig(pose: FiggiePose, spin: RigSpin): FiggiePose {
  const unit = (v: number) => Math.max(-1, Math.min(1, Number.isFinite(v) ? v : 0));
  const part = (v: number) => RIG_SPIN_RANGE * unit(v);
  const roll = quatFromAxisAngle(0, 0, 1, part(spin.z));
  const pitch = quatFromAxisAngle(1, 0, 0, part(spin.x));
  const yaw = quatFromAxisAngle(0, 1, 0, part(spin.y));
  const q = quatNormalize(quatMul(yaw, quatMul(pitch, roll)));
  const angles: Angles = { ...pose.angles };
  if (Math.abs(q[3]) >= 1 - 1e-9) delete angles.root;
  else angles.root = q;
  return { ...pose, angles };
}

export interface SpineShape {
  /** Curl forward (+) or arch back (−), −1..1. */
  bend: number;
  /** Turn the shoulders about the figure's up axis, −1..1. */
  twist: number;
  /** Tip sideways, −1..1. */
  lean: number;
}

/**
 * Shape the spine column: bend, twist and lean together, since all three
 * write the SAME two bones (the lower spine and the chest). Each parameter
 * is −1..1 with 0 straight; the total for each is split evenly between the
 * bones, so the column curves rather than hinging at one point.
 *
 * The three compose in a fixed order — lean, then bend, then twist — so a
 * given triple always produces the same posture however the sliders were
 * moved to reach it.
 */
export function shapeSpine(pose: FiggiePose, shape: SpineShape): FiggiePose {
  const unit = (v: number) => Math.max(-1, Math.min(1, Number.isFinite(v) ? v : 0));
  const angles: Angles = { ...pose.angles };
  for (const [id, share] of SPINE_COLUMN) {
    const part = (range: number, v: number) => range * unit(v) * share;
    // Negated so the slider reads as it looks: pushed left, the figure
    // tips to the viewer's left.
    const lean = quatFromAxisAngle(0, 0, 1, -part(SPINE_RANGE.lean, shape.lean));
    const bend = quatFromAxisAngle(1, 0, 0, part(SPINE_RANGE.bend, shape.bend));
    const twist = quatFromAxisAngle(0, 1, 0, part(SPINE_RANGE.twist, shape.twist));
    const q: Quat = quatNormalize(quatMul(twist, quatMul(bend, lean)));
    if (Math.abs(q[3]) >= 1 - 1e-9) delete angles[id];
    else angles[id] = q;
  }
  return { ...pose, angles };
}
