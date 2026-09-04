// POSTURE SHAPERS: named, whole-part poses a host can drive from a single
// slider — curl a hand into a fist, point or flatten a foot, bend / twist /
// lean the spine.
//
// Every shaper is ABSOLUTE, not a delta: dragging a slider repeatedly
// re-derives the same joints instead of compounding, and two shapers never
// fight because their joint sets are disjoint (one hand, one foot, the
// spine column). Identity results are ELIDED rather than stored, so a
// shaper at rest leaves a pose byte-identical to one that was never shaped
// — which is what keeps a "nothing changed" commit from building an undo
// entry.
//
// They differ in what they are absolute ABOUT. curlHand and flexFoot own
// their joints outright and write them from scratch: a hand has no single
// "fistness" to preserve, so the slider simply says what the hand is. The
// spine and the twists instead take the pose they are handed as their
// zero and add their own dimension to it, because those joints carry other
// posing too — a dragged reach, a bend the player put in by hand — and a
// slider that owns one dimension must not throw the rest away. Those
// shapers are absolute only with respect to the pose given them, so a host
// must feed them one fixed base pose for as long as a set of slider
// positions is live.
//
// The host decides WHEN to apply one. Figgie deliberately offers no way to
// read a slider position back out of a pose: a hand posed finger by finger
// has no single "fistness", so a host shows its sliders at rest and only
// touches the pose once the user moves one.

import { FiggiePose } from './pose';
import { FINGER_NAMES, FingerName, FOOT_SPLAY, JointId, restJoint } from './skeleton';
import {
  QUAT_IDENTITY, Quat, quatFromAxisAngle, quatInv, quatIsIdentity, quatMul, quatNormalize,
} from './quat';

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

/** Where on the curl slider the fingers stand exactly STRAIGHT — a tenth
 *  of the way up, not at the very bottom. Below it the hand opens PAST
 *  straight, the fingers bending back the way a relaxed open hand does;
 *  dead flat at the end of the travel read as a stiff paddle. A host's
 *  REST value for the slider is this number, not zero (editor-ui's
 *  RIG_SLIDER_REST), or an untouched bar would misreport the figure. */
export const HAND_STRAIGHT_AT = 0.1;

/** The finger's posable segments and each one's SHARE of that travel
 *  (summing to 1). Every knuckle takes a comparable part of the curl —
 *  slightly more at the base, as a finger folds — so the whole finger
 *  arcs into the palm instead of staying straight and hinging at one
 *  joint. (Segment 0 is the rigid base knuckle on the palm rim; the palm
 *  itself cups through its own bend joint.) */
export const FINGER_COLUMN: ReadonlyArray<[1 | 2 | 3, number]> = [
  [1, 0.36], [2, 0.34], [3, 0.3],
];

/** Fully-pointed foot: the ankle extends the foot well down toward the
 *  shin's line, the toe box carrying a little further. The first number
 *  swings the HEEL — the bone that hangs off the ankle — so the whole foot
 *  pitches about the ankle, exactly as pointing a real foot does: the sole
 *  swings from flat to steep and the heel rides back and up, the shape of
 *  standing on tiptoe. Stopping short of the shin's own line is deliberate;
 *  a foot folded flat against the shin reads as broken, not as pointed. */
const POINT_ANKLE = 0.95;
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

/** How far a twist slider rolls a joint about its own bone, radians end to
 *  end. The WRIST turns past what a forearm strictly does — a mannequin is
 *  posed for expression, not anatomy, and the extra reach is what lets a
 *  palm face anywhere; the ANKLE turns far less by comparison, which is
 *  also true of the real thing — a foot that swivelled like a hand would
 *  read as broken — but far enough now to plant toes well in or out. */
export const TWIST_RANGE = { wrist: 4.4, ankle: 2.4 };

/** The direction a bone points at rest, in its PARENT's frame — the axis a
 *  roll of that bone turns about. Taken from the skeleton rather than
 *  written down here, so it can never fall out of step with it. */
function boneAxis(id: JointId): [number, number, number] {
  const j = restJoint(id);
  const len = Math.hypot(j.dx, j.dy, j.dz) || 1;
  return [j.dx / len, j.dy / len, j.dz / len];
}

/**
 * ROLL one joint about its own bone, leaving where the bone points alone.
 *
 * Every other shaper owns its joints outright and writes them from
 * scratch. A wrist or an ankle can't be owned that way: they are also
 * where a drag's IK lands, and overwriting one would throw away the reach
 * the player posed. So this splits the joint's rotation in two — the SWING
 * that aims the bone, and the TWIST that rolls it about its own length —
 * keeps the swing exactly as it found it, and rewrites only the twist.
 *
 * That leaves the shaper absolute all the same: re-deriving from the
 * slider twice running gives the identical rotation, because the swing it
 * reads back carries no roll of its own to compound with.
 */
function setTwist(
  angles: Angles, id: JointId, axis: [number, number, number], angle: number,
): void {
  const [ax, ay, az] = axis;
  const held = angles[id];
  let swing = QUAT_IDENTITY;
  if (held) {
    // The rotation's vector part along the bone IS its roll; divide that
    // out and what remains is the aim. (A half turn square across the bone
    // has no roll to speak of — the projection vanishes — and leaves the
    // aim untouched, which is the right answer anyway.)
    const d = held[0] * ax + held[1] * ay + held[2] * az;
    const roll: Quat = [ax * d, ay * d, az * d, held[3]];
    swing = Math.hypot(...roll) < 1e-6
      ? held
      : quatNormalize(quatMul(held, quatInv(quatNormalize(roll))));
  }
  const out = quatNormalize(quatMul(swing, quatFromAxisAngle(ax, ay, az, angle)));
  if (quatIsIdentity(out, 1e-6)) delete angles[id];
  else angles[id] = out;
}

/**
 * Twist one wrist: `t` −1..1, 0 = as the arm left it. The hand rolls about
 * the forearm's own line — the turn that shows a palm or the back of a
 * hand — and the arm's reach is untouched, so twisting a hand the player
 * dragged somewhere leaves it exactly where they put it. Writes only that
 * wrist.
 */
export function twistWrist(pose: FiggiePose, side: Side, t: number): FiggiePose {
  const wrist = `wrist${side}` as JointId;
  const angles: Angles = { ...pose.angles };
  // Each forearm points OUT from the body, so the two bone axes already
  // face opposite ways. Mirroring the hands — both palms turning toward
  // the figure, or both away — therefore wants the SAME turn in the world,
  // which is opposite signs about those two axes.
  const sign = side === 'L' ? -1 : 1;
  setTwist(angles, wrist, boneAxis(wrist), (TWIST_RANGE.wrist / 2) * centeredValue(t) * sign);
  return { ...pose, angles };
}

/** How far the bend slider hinges a hand at the wrist, radians end to end
 *  — a touch past what a real wrist manages either way, on the mannequin
 *  principle the twist range is already sized by. */
export const WRIST_BEND_RANGE = 2.2;

/**
 * Bend one wrist: `t` −1..1, 0 = straight (the hand in line with the
 * forearm), ±1 the hand laid back or folded forward. The hinge is the
 * mid-palm pin, so the WHOLE hand turns — palm plate, knuckle line, all
 * five fingers — against a forearm that stays exactly where the arm put
 * it. Turns about the knuckle line, the same axis the fingers curl about,
 * which is what makes it a flex and not a wave.
 *
 * Owns that one joint outright and reads nothing back, so it is absolute
 * and idempotent like the other hand shapers, and disjoint from all three
 * of them: the curl owns the knuckle line and the finger columns, the
 * twist the wrist's roll, the spread the finger bases' roll.
 */
export function bendWrist(pose: FiggiePose, side: Side, t: number): FiggiePose {
  // Each hand reaches the opposite way down its own arm, so the two want
  // opposite senses about the rig's up axis to fold the same way — the
  // flip curlHand makes, for the same reason.
  const axis: [number, number, number] = [0, side === 'L' ? 1 : -1, 0];
  const angles: Angles = { ...pose.angles };
  setAngle(angles, `palm${side}` as JointId, axis, (WRIST_BEND_RANGE / 2) * centeredValue(t));
  return { ...pose, angles };
}

/**
 * Twist one ankle: `t` −1..1, 0 = as the leg left it. The foot swivels
 * about the shin's line — toes turning out or in — while the leg's reach
 * stays put. Writes only that ankle.
 */
export function twistAnkle(pose: FiggiePose, side: Side, t: number): FiggiePose {
  const ankle = `ankle${side}` as JointId;
  const angles: Angles = { ...pose.angles };
  // Both shins point straight DOWN — one axis, no left or right of its own
  // — so here it is the SENSE of the turn that mirrors the two feet, and
  // one sign of the slider turns both sets of toes outward.
  const sign = side === 'L' ? 1 : -1;
  setTwist(angles, ankle, boneAxis(ankle), (TWIST_RANGE.ankle / 2) * centeredValue(t) * sign);
  return { ...pose, angles };
}

/** −1..1, clamped — what a centered slider hands a shaper. */
function centeredValue(v: number): number {
  return !Number.isFinite(v) ? 0 : v < -1 ? -1 : v > 1 ? 1 : v;
}

/**
 * Curl one hand: `t` 1 = a closed fist, HAND_STRAIGHT_AT = every finger
 * straight, 0 = the open hand bent a little back PAST straight.
 * The fingers fold in the rig plane — about the view-normal z at rest —
 * each segment tighter than the last, and the palm cups slightly as it
 * closes. Writes only that hand's finger segments and its palm-bend joint.
 */
export function curlHand(pose: FiggiePose, side: Side, t: number): FiggiePose {
  // The travel measured from STRAIGHT rather than from the slider's floor:
  // 1 at a closed fist, 0 at HAND_STRAIGHT_AT, and negative below it — the
  // same turn run backwards, which bends the fingers back past straight.
  const k = (clamp01(t) - HAND_STRAIGHT_AT) / (1 - HAND_STRAIGHT_AT);
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
      // Written as the joint's TWIST about the knuckle line rather than a
      // wholesale replace, so the spread's fan turn at the base segment
      // (a twist about the palm normal — see spreadHand) survives a
      // re-curl: each shaper owns its own component of the same joint.
      setTwist(angles, `${name}${side}${seg}` as JointId, axis, range * share * k);
    }
  }
  return { ...pose, angles };
}

/** How far the spread slider fans the fingers, radians end to end (scaled
 *  per finger by SPREAD_SHARES). */
export const SPREAD_RANGE = 1.0;

/** Each finger's SHARE of the spread. The fan opens about the middle
 *  finger's line — outer fingers travel farther, the way a real hand
 *  splays — and the thumb, hinged inboard on the palm, travels farthest of
 *  all. Signs are the LEFT hand's (+y is the thumb side of its fan); the
 *  right mirrors through the axis flip in {@link spreadHand}. */
const SPREAD_SHARES: Record<FingerName, number> = {
  thumb: 1.25, index: 0.55, middle: 0.1, ring: -0.4, pinky: -0.9,
};

/**
 * Spread one hand: `t` −1..1, 0 = the fan exactly as the rig models it,
 * +1 fingers splayed wide, −1 squeezed together. Each finger turns about
 * the palm's NORMAL at its base segment — the fan plane the fingers
 * already lie in — by its own share of the range.
 *
 * Absolute and idempotent like the other hand shapers, and written as a
 * TWIST about the palm normal (the swing–twist split setTwist makes), so
 * it composes with the curl at the same joints instead of overwriting it:
 * the curl is a swing about the knuckle line and rides through untouched —
 * a spread fist stays a fist. Writes only that hand's finger bases.
 */
export function spreadHand(pose: FiggiePose, side: Side, t: number): FiggiePose {
  const angles: Angles = { ...pose.angles };
  // Left fingers reach along −x, so a positive turn about +z closes the
  // fan; the right hand mirrors. Flip the axis so +t always spreads.
  const sign = side === 'L' ? -1 : 1;
  for (const name of FINGER_NAMES) {
    const angle = (SPREAD_RANGE / 2) * centeredValue(t) * SPREAD_SHARES[name];
    setTwist(angles, `${name}${side}1` as JointId, [0, 0, sign], angle);
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
 * foot's heel and toe joints — the heel pitches the whole foot about the
 * ankle, the toe curls the tip a little further; the BALL is left alone, so
 * a foot the player has bent at the ball keeps that bend while this slider
 * points it.
 */
export function flexFoot(pose: FiggiePose, side: Side, t: number): FiggiePose {
  const point = 1 - clamp01(t); // 1 = fully pointed
  const axis = footAxis(side);
  const angles: Angles = { ...pose.angles };
  setAngle(angles, `heel${side}` as JointId, axis, POINT_ANKLE * point);
  setAngle(angles, `toe${side}` as JointId, axis, POINT_TOE * point);
  return { ...pose, angles };
}

/** How far the ball can fold the forefoot DOWN through the arch, radians —
 *  well short of vertical, the steep-soled shape of a foot standing on
 *  tiptoe. */
export const BALL_BEND_RANGE = 0.9;

/**
 * Bend one foot in the MIDDLE: `t` 0 = flat (the rest pose), 1 = the ball
 * and toes swung fully down — the heel stays put and the forefoot folds
 * under, the foot bent as if standing on tiptoe. Writes only that
 * foot's ball joint (the heel→ball bone, pivoting at the heel) — the
 * slot {@link flexFoot} deliberately leaves alone — so the two compose:
 * a pointed foot keeps its point while the arch folds, and vice versa.
 * Absolute and idempotent like the other foot shapers.
 */
export function bendBall(pose: FiggiePose, side: Side, t: number): FiggiePose {
  const angles: Angles = { ...pose.angles };
  // The same positive sense flexFoot points with: toes DOWN — a tiptoe
  // fold, not toes lifted in the air.
  setAngle(angles, `ball${side}` as JointId, footAxis(side), BALL_BEND_RANGE * clamp01(t));
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
 * write the SAME bones. Each parameter is −1..1 with 0 meaning "as the
 * pose already stood"; the total for each is split along the column, so it
 * curves rather than hinging at one point.
 *
 * The three compose in a fixed order — lean, then bend, then twist — so a
 * given triple always produces the same posture however the sliders were
 * moved to reach it.
 *
 * It ADDS that shape to whatever the column already holds rather than
 * writing over it, and adds it in the figure's OWN frame: lean an
 * already-bent spine and it tips sideways from where it stood, keeping the
 * bend, which is what a slider that owns one dimension has to do. (Over a
 * straight column the two are the same thing, so a figure posed only from
 * these sliders is shaped exactly as it always was.)
 *
 * Adding rather than overwriting means it is absolute only with respect to
 * the pose it is HANDED: a host must keep feeding it the same base pose
 * for as long as one set of slider positions is live, or a second nudge of
 * a slider will pile onto the first instead of replacing it.
 */
export function shapeSpine(pose: FiggiePose, shape: SpineShape): FiggiePose {
  return shapeColumn(pose, SPINE_COLUMN, [
    // Lean's range is NEGATED so the slider reads as it looks: pushed one
    // way, the figure tips that way on screen.
    [[0, 0, 1], -SPINE_RANGE.lean, shape.lean],
    [[1, 0, 0], SPINE_RANGE.bend, shape.bend],
    [[0, 1, 0], SPINE_RANGE.twist, shape.twist],
  ]);
}

/** How far the head sliders can carry it, radians end to end (applied
 *  along {@link HEAD_COLUMN}). A nod reaches chin-to-chest and a good way
 *  back; a shake turns the face nearly square to the side, which is about
 *  as far as a real neck goes before the shoulders have to follow; a tilt
 *  lays the ear most of the way to the shoulder, the shortest reach of the
 *  three because a real neck's roll is the stiffest of its turns. */
export const HEAD_RANGE = { nod: 1.1, shake: 1.4, tilt: 0.9 };

/** The column the head sliders turn. All of it rides the HEAD joint, whose
 *  angle swings the head bone about its parent — the NECK joint, which the
 *  skeleton parks at the TOP of the drawn neck, the ball's underside
 *  (skeleton.ts). So a nod hinges where the skull meets the neck, the ball
 *  tipping about the point it sits on. The neck joint's own angle bends
 *  the neck at its base on the chest; that is the spine sliders' business
 *  ({@link SPINE_COLUMN}), not the head's — a share of the head's turn
 *  there swung the ball around the chest, which read as the body bowing,
 *  not the head nodding. */
export const HEAD_COLUMN: ReadonlyArray<[JointId, number]> = [
  ['head', 1],
];

export interface HeadShape {
  /** Chin down (+) or face up (−), −1..1. */
  nod: number;
  /** Turn the face to one side, −1..1. */
  shake: number;
  /** Ear toward shoulder (the roll about the gaze — the axis nod and shake
   *  leave over), −1..1. Optional: older callers shape two axes. */
  tilt?: number;
}

/**
 * Shape the head: nod and shake together, since both write the SAME
 * joint. Each is −1..1 with 0 meaning "as the pose already stood", applied
 * along {@link HEAD_COLUMN} — all of it on the head joint, so every turn
 * hinges at the top of the neck.
 *
 * The spine's own sliders reach up through the neck and head (they are the
 * last two links of {@link SPINE_COLUMN}, so a deep bend has the figure
 * looking at its own feet). These are the head ALONE — a shorter column —
 * so a nod tips the face without the body following.
 *
 * ADDS its turn to whatever the joints already hold, in the figure's own
 * frame, exactly as {@link shapeSpine} does: nod an already-shaken head and
 * the chin drops from where the face was pointing. Which makes it absolute
 * only with respect to the pose it is HANDED — a host must keep feeding it
 * one fixed base for as long as a set of slider positions is live.
 */
export function shapeHead(pose: FiggiePose, shape: HeadShape): FiggiePose {
  return shapeColumn(pose, HEAD_COLUMN, [
    [[1, 0, 0], HEAD_RANGE.nod, shape.nod],
    [[0, 1, 0], HEAD_RANGE.shake, shape.shake],
    // The third, orthogonal axis: a roll about the gaze, so it moves the
    // face nowhere — only lays the head over.
    [[0, 0, 1], HEAD_RANGE.tilt, shape.tilt ?? 0],
  ]);
}

/**
 * The one thing the spine and the head sliders both do: add a turn to a
 * CHAIN of joints, each taking its own share, so the run of bones curves
 * rather than hinging at one place.
 *
 * `turns` are [axis, radians end to end, −1..1 value] applied innermost
 * first — the fixed composition order that makes a set of slider positions
 * describe one posture however they were reached. Each value is clamped to
 * −1..1 first, so a caller cannot fold a joint through itself with a stray
 * number (nor with a NaN, which would poison the whole quaternion).
 *
 * Every joint's share is ADDED to what it already carries (`held · shaped`):
 * what the joint holds turns first, then these turn it further about the
 * axes it now points along. A joint left at an identity rotation is DELETED
 * rather than stored, so sliders at rest leave a pose byte-identical to one
 * that was never shaped — which is what keeps a "nothing changed" commit
 * from building an undo entry.
 */
function shapeColumn(
  pose: FiggiePose,
  column: ReadonlyArray<[JointId, number]>,
  turns: ReadonlyArray<[[number, number, number], number, number]>,
): FiggiePose {
  const angles: Angles = { ...pose.angles };
  for (const [id, share] of column) {
    let shaped: Quat = QUAT_IDENTITY;
    for (const [[ax, ay, az], range, value] of turns) {
      shaped = quatMul(
        quatFromAxisAngle(ax, ay, az, range * centeredValue(value) * share),
        shaped,
      );
    }
    shaped = quatNormalize(shaped);
    const held = pose.angles[id];
    const q = held ? quatNormalize(quatMul(held, shaped)) : shaped;
    if (Math.abs(q[3]) >= 1 - 1e-9) delete angles[id];
    else angles[id] = q;
  }
  return { ...pose, angles };
}
