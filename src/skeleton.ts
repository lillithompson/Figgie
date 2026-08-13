// Figgie's skeleton: an animator's stick-figure mannequin, proportioned
// after AnimationMentor's Stewie rig — big ball head with dot eyes, thin
// tan capsule limbs, a broad ribcage over a waist over a pear-shaped
// pelvis with hip balls, paddle hands with thumbs, and heel-and-toe feet
// that point at the camera.
//
// Everything here is REST data: joints in the T-pose, the bones between
// them, and which joints the finger may grab. Units are "rig units" with
// the figure exactly 100 tall, y up, x to the figure's right on screen,
// z toward the viewer. The pose layer (pose.ts) rotates bones in the x/y
// plane only — Figgie is a 2.5D rig: all POSING happens in the plane of
// the screen, while rest z-offsets (feet, hands, eyes) give the figure
// enough depth that turning it about its up axis (view.ts yaw) reads as a
// wooden mannequin turning, not a paper cutout.

export type JointId =
  | 'root'      // pelvis center — dragging it carries the whole figure
  | 'spine'     // lower-torso bend
  | 'chest'     // upper-torso bend
  | 'neck'      // rigid riser the head pivots on (not itself posable)
  | 'head'      // head-ball center
  | 'shoulderL' | 'shoulderR' // clavicle ends — dragging shrugs/swings
  | 'elbowL' | 'elbowR'
  | 'wristL' | 'wristR'
  | 'hipL' | 'hipR'           // pelvis corners (rigid — the pelvis is one piece)
  | 'kneeL' | 'kneeR'
  | 'ankleL' | 'ankleR';

export interface RestJoint {
  id: JointId;
  parent: JointId | null;
  /** Rest offset from the parent joint, rig units. The z component never
   *  participates in posing — it rides through FK untouched. */
  dx: number;
  dy: number;
  dz: number;
  /** Whether the bone ENDING at this joint takes a pose angle. A rigid
   *  bone (neck, pelvis corners) keeps its rest direction always. */
  posable: boolean;
}

/** The figure's height in rig units — the scale everything else is in. */
export const RIG_HEIGHT = 100;

/**
 * Rest skeleton, root first (parents always precede children, so a single
 * forward walk resolves world transforms). Proportions measured off the
 * Stewie reference: head ball ~1/5 of standing height, shoulders at ~3/4,
 * long thin arms whose T-pose span is wider than the figure is tall.
 */
export const SKELETON: readonly RestJoint[] = [
  { id: 'root', parent: null, dx: 0, dy: 55, dz: 0, posable: false },
  { id: 'spine', parent: 'root', dx: 0, dy: 8, dz: 0, posable: true },
  { id: 'chest', parent: 'spine', dx: 0, dy: 8, dz: 0, posable: true },
  { id: 'neck', parent: 'chest', dx: 0, dy: 7, dz: 0, posable: false },
  { id: 'head', parent: 'neck', dx: 0, dy: 11.8, dz: 0, posable: true },
  { id: 'shoulderL', parent: 'chest', dx: -9.5, dy: 5, dz: 0, posable: true },
  { id: 'shoulderR', parent: 'chest', dx: 9.5, dy: 5, dz: 0, posable: true },
  { id: 'elbowL', parent: 'shoulderL', dx: -13.5, dy: 0, dz: 0, posable: true },
  { id: 'elbowR', parent: 'shoulderR', dx: 13.5, dy: 0, dz: 0, posable: true },
  { id: 'wristL', parent: 'elbowL', dx: -12.5, dy: 0, dz: 0, posable: true },
  { id: 'wristR', parent: 'elbowR', dx: 12.5, dy: 0, dz: 0, posable: true },
  { id: 'hipL', parent: 'root', dx: -5.5, dy: -3, dz: 0, posable: false },
  { id: 'hipR', parent: 'root', dx: 5.5, dy: -3, dz: 0, posable: false },
  { id: 'kneeL', parent: 'hipL', dx: 0, dy: -23, dz: 0, posable: true },
  { id: 'kneeR', parent: 'hipR', dx: 0, dy: -23, dz: 0, posable: true },
  { id: 'ankleL', parent: 'kneeL', dx: 0, dy: -23, dz: 0, posable: true },
  { id: 'ankleR', parent: 'kneeR', dx: 0, dy: -23, dz: 0, posable: true },
];

export const JOINT_IDS: readonly JointId[] = SKELETON.map((j) => j.id);

const BY_ID = new Map(SKELETON.map((j) => [j.id, j]));

export function restJoint(id: JointId): RestJoint {
  return BY_ID.get(id)!;
}

/**
 * The joints a finger can grab, and what a drag does — Pivot Animator's
 * model (drag a joint, the bone ending at it rotates about its parent and
 * the subtree follows rigidly), plus the two exceptions posing tools have
 * settled on: the ROOT translates the whole figure, and the chain ENDS
 * (wrists, ankles) solve 2-bone IK — reaching a hand toward a point is
 * what fingers do most, and plain FK there would only spin the forearm.
 */
export type DragKind = 'translate' | 'fk' | 'ik2';

export interface DragTarget {
  joint: JointId;
  kind: DragKind;
  /** ik2 only: the two posable joints the solve writes (chain root first). */
  chain?: [JointId, JointId];
}

export const DRAG_TARGETS: readonly DragTarget[] = [
  { joint: 'root', kind: 'translate' },
  { joint: 'spine', kind: 'fk' },
  { joint: 'chest', kind: 'fk' },
  { joint: 'head', kind: 'fk' },
  { joint: 'shoulderL', kind: 'fk' },
  { joint: 'shoulderR', kind: 'fk' },
  { joint: 'elbowL', kind: 'fk' },
  { joint: 'elbowR', kind: 'fk' },
  { joint: 'wristL', kind: 'ik2', chain: ['elbowL', 'wristL'] },
  { joint: 'wristR', kind: 'ik2', chain: ['elbowR', 'wristR'] },
  { joint: 'kneeL', kind: 'fk' },
  { joint: 'kneeR', kind: 'fk' },
  { joint: 'ankleL', kind: 'ik2', chain: ['kneeL', 'ankleL'] },
  { joint: 'ankleR', kind: 'ik2', chain: ['kneeR', 'ankleR'] },
];

export function dragTargetFor(joint: JointId): DragTarget | undefined {
  return DRAG_TARGETS.find((t) => t.joint === joint);
}

// ── Flesh ───────────────────────────────────────────────────────────
// What the renderer (and the silhouette baker) hang on the bones. Kept
// beside the skeleton so the two can't drift: a capsule names the two
// joints it spans, an attachment names the joint it rides.

/** A capsule from joint `a` to joint `b`, radius in rig units. */
export interface BodyCapsule {
  a: JointId;
  b: JointId;
  radius: number;
}

export const BODY_CAPSULES: readonly BodyCapsule[] = [
  // The torso is a SPINE — a slim column — carrying two masses (the pelvis
  // pear below, the ribcage above) rather than one undifferentiated
  // sausage. The waist that shows between them is what makes a bend at
  // spine or chest read as a bend at all.
  { a: 'root', b: 'spine', radius: 3.6 },   // waist
  { a: 'spine', b: 'chest', radius: 4.0 },  // lower ribcage
  { a: 'chest', b: 'neck', radius: 1.7 },   // neck
  { a: 'chest', b: 'shoulderL', radius: 1.7 },
  { a: 'chest', b: 'shoulderR', radius: 1.7 },
  { a: 'shoulderL', b: 'elbowL', radius: 1.7 },
  { a: 'shoulderR', b: 'elbowR', radius: 1.7 },
  { a: 'elbowL', b: 'wristL', radius: 1.5 },
  { a: 'elbowR', b: 'wristR', radius: 1.5 },
  { a: 'root', b: 'hipL', radius: 3.4 },
  { a: 'root', b: 'hipR', radius: 3.4 },
  { a: 'hipL', b: 'kneeL', radius: 2.3 },
  { a: 'hipR', b: 'kneeR', radius: 2.3 },
  { a: 'kneeL', b: 'ankleL', radius: 1.9 },
  { a: 'kneeR', b: 'ankleR', radius: 1.9 },
];

/** An ellipsoid riding one joint: the head ball, the ribcage and pelvis
 *  masses, the hip balls, the paddle hands with their thumbs, and the
 *  heel-and-toe feet (which extend in +z — toward the viewer at rest — and
 *  are most of why the turn reads as 3D). Offsets are in the joint's POSED
 *  frame for x/y (they swing with the bone) and rest z. */
export interface BodyBlob {
  joint: JointId;
  /** Offset from the joint, in the joint's posed frame (x/y) + rest z. */
  ox: number;
  oy: number;
  oz: number;
  /** Ellipsoid half-extents, rig units. */
  rx: number;
  ry: number;
  rz: number;
  /** Colour role — the face dots are the one non-body part. */
  tint?: 'eye';
}

export const BODY_BLOBS: readonly BodyBlob[] = [
  { joint: 'head', ox: 0, oy: 0, oz: 0, rx: 10.2, ry: 10.2, rz: 10.2 },
  { joint: 'head', ox: -3, oy: 1.5, oz: 9.3, rx: 0.9, ry: 1.3, rz: 0.6, tint: 'eye' },
  { joint: 'head', ox: 3, oy: 1.5, oz: 9.3, rx: 0.9, ry: 1.3, rz: 0.6, tint: 'eye' },
  // Ribcage: broad across, shallower front-to-back, hung BELOW the chest
  // joint so it fills the span up from the waist. Wider than the pelvis at
  // the shoulders, which is what gives the figure a torso shape instead of
  // a tube — and it swings with the chest, so a twist reads.
  { joint: 'chest', ox: 0, oy: -2.4, oz: 0, rx: 6.6, ry: 5.8, rz: 4.6 },
  // Pelvis pear, and the two hip balls the thighs socket into: without
  // them the legs grew straight out of the pear and the hip line vanished.
  { joint: 'root', ox: 0, oy: 0, oz: 0, rx: 6.8, ry: 5.4, rz: 5.0 },
  { joint: 'hipL', ox: 0, oy: 0, oz: 0, rx: 3.0, ry: 2.8, rz: 3.0 },
  { joint: 'hipR', ox: 0, oy: 0, oz: 0, rx: 3.0, ry: 2.8, rz: 3.0 },
  // Hands: a flat paddle palm with a thumb nub off its inboard front edge,
  // so a turned hand reads as a hand and not a lozenge.
  { joint: 'wristL', ox: -3.0, oy: 0, oz: 0, rx: 3.0, ry: 1.15, rz: 2.4 },
  { joint: 'wristL', ox: -1.8, oy: 0.15, oz: 2.2, rx: 1.4, ry: 0.85, rz: 1.2 },
  { joint: 'wristR', ox: 3.0, oy: 0, oz: 0, rx: 3.0, ry: 1.15, rz: 2.4 },
  { joint: 'wristR', ox: 1.8, oy: 0.15, oz: 2.2, rx: 1.4, ry: 0.85, rz: 1.2 },
  // Feet: a heel behind the ankle and a toe box in front, soles level, so
  // the foot has a front and a back. Their length lies in +z (toward the
  // viewer at rest), which is most of why turning the figure reads as 3D.
  { joint: 'ankleL', ox: 0, oy: -2.5, oz: -1.4, rx: 2.2, ry: 1.9, rz: 2.3 },
  { joint: 'ankleL', ox: 0, oy: -2.9, oz: 3.4, rx: 2.4, ry: 1.5, rz: 4.3 },
  { joint: 'ankleR', ox: 0, oy: -2.5, oz: -1.4, rx: 2.2, ry: 1.9, rz: 2.3 },
  { joint: 'ankleR', ox: 0, oy: -2.9, oz: 3.4, rx: 2.4, ry: 1.5, rz: 4.3 },
];

/** Grab-knob radius drawn (and hit-tested) at each drag target, rig units.
 *  A whisker larger than the bone under it so the affordance reads. */
export function knobRadius(joint: JointId): number {
  switch (joint) {
    case 'root': return 4.2;
    case 'spine': case 'chest': return 3.4;
    case 'head': return 3.6;
    default: return 2.6;
  }
}
