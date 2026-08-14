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

/** The five fingers; each is a chain of four joints — `0` the rigid base
 *  knuckle, then three POSABLE segments ending at `3`, the tip. All FINE
 *  targets — grabbable only zoomed in. */
export type FingerName = 'thumb' | 'index' | 'middle' | 'ring' | 'pinky';
type FingerJointId = `${FingerName}${'L' | 'R'}${0 | 1 | 2 | 3}`;
/** The palm's own chain: a rigid mid-palm pin (the hinge), and the
 *  posable knuckle-line joint — the effector that bends the palm in the
 *  middle, carrying the outer palm and all four fingers. */
type PalmJointId = `${'palm' | 'knuck'}${'L' | 'R'}`;

export type JointId =
  | 'root'      // pelvis center — dragging it carries the whole figure
  | 'spine'     // lower-torso bend
  | 'chest'     // upper-torso bend
  | 'neck'      // the riser the head sits on — takes its own share of a
               // spine bend, so the curve carries through to the head
  | 'head'      // head-ball center
  | 'collar'    // top of the chest — tilts the whole shoulder line
  | 'shoulderL' | 'shoulderR' // clavicle ends — dragging shrugs/swings
  | 'elbowL' | 'elbowR'
  | 'wristL' | 'wristR'
  | 'hipL' | 'hipR'           // pelvis corners (rigid — the pelvis is one piece)
  | 'kneeL' | 'kneeR'
  | 'ankleL' | 'ankleR'
  | 'ballL' | 'ballR'         // ball of the foot — the hinge the toe bends at
  | 'toeL' | 'toeR'           // toe tip — the foot chain's end effector
  | PalmJointId
  | FingerJointId;

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

/** The hand's reach, wrist to middle fingertip, rig units — what the
 *  "palm big enough on screen" zoom gate for fine targets measures.
 *  (= the middle tip's base-table reach × FINGER_REACH.) */
export const HAND_SPAN = 11.3;

/** How far each foot splays outward from straight-ahead (radians about
 *  the vertical) — a standing figure's stance, and what keeps the foot
 *  chain poseable even face-on. */
export const FOOT_SPLAY = 0.5;

/** One step of `len` along the splayed foot direction (side −1 = left,
 *  splaying −x), dropping `dy`. */
function footStep(side: -1 | 1, len: number, dy: number) {
  return {
    dx: side * Math.sin(FOOT_SPLAY) * len,
    dy,
    dz: Math.cos(FOOT_SPLAY) * len,
    posable: true as const,
  };
}

// ── The hands' skeleton ─────────────────────────────────────────────

export const FINGER_NAMES: readonly FingerName[] = [
  'thumb', 'index', 'middle', 'ring', 'pinky',
];

/** Each finger's TIP at rest, in the LEFT wrist's frame (x mirrors for the
 *  right): the fan the whole chain lies along. The thumb reaches shortest,
 *  high and inboard; the middle finger defines {@link HAND_SPAN}. */
const FINGER_TIPS: Record<FingerName, [number, number]> = {
  thumb: [-3.4, 3.6],
  index: [-6.9, 1.6],
  middle: [-7.4, 0.3],
  ring: [-7.0, -0.9],
  pinky: [-6.1, -2.0],
};

/** How far past the base tables the drawn hand reaches — sized so the
 *  MIDDLE FINGER (knuckle to tip) is as long as the palm itself. */
const FINGER_REACH = 1.53;

/** Wrist → mid-palm hinge, and wrist → knuckle line, rig units (the palm
 *  volume spans just past the wrist's circle out to the rim). */
const PALM_MID_X = 3.8;
const PALM_RIM_X = 6.3;

/** Where each finger's chain splits the wrist→tip line: the rigid base
 *  knuckle, then THREE posable segments to the tip. The four fingers'
 *  bases sit on the knuckle line; the thumb's on the inner palm's upper
 *  corner. */
function fingerStops(name: FingerName): readonly number[] {
  return name === 'thumb' ? [0.4, 0.6, 0.8, 1] : [0.56, 0.71, 0.855, 1];
}

function fingerJoints(): RestJoint[] {
  const out: RestJoint[] = [];
  for (const side of ['L', 'R'] as const) {
    const mx = side === 'L' ? 1 : -1; // tables are authored LEFT (−x out)
    const wrist: JointId = side === 'L' ? 'wristL' : 'wristR';
    const palm = `palm${side}` as JointId;
    const knuck = `knuck${side}` as JointId;
    // The palm chain: rigid pin at the middle, posable knuckle line — the
    // bend effector; rotating it hinges the outer palm at the pin.
    out.push({ id: palm, parent: wrist, dx: mx * -PALM_MID_X, dy: 0, dz: 0, posable: false });
    out.push({
      id: knuck, parent: palm,
      dx: mx * -(PALM_RIM_X - PALM_MID_X), dy: 0, dz: 0, posable: true,
    });
    for (const name of FINGER_NAMES) {
      const [bx, by] = FINGER_TIPS[name];
      const tipX = bx * FINGER_REACH; // left-authored; mx mirrors
      const tipY = by * FINGER_REACH;
      // The thumb rides the INNER palm (a palm bend leaves it put); the
      // four fingers ride the knuckle line and bend with it.
      const anchor = name === 'thumb' ? palm : knuck;
      const anchorX = name === 'thumb' ? -PALM_MID_X : -PALM_RIM_X;
      const stops = fingerStops(name);
      out.push({
        id: `${name}${side}0` as JointId,
        parent: anchor,
        dx: mx * (tipX * stops[0] - anchorX),
        dy: tipY * stops[0],
        dz: 0,
        posable: false,
      });
      for (let i = 1; i < stops.length; i++) {
        out.push({
          id: `${name}${side}${i}` as JointId,
          parent: `${name}${side}${i - 1}` as JointId,
          dx: mx * tipX * (stops[i] - stops[i - 1]),
          dy: tipY * (stops[i] - stops[i - 1]),
          dz: 0,
          posable: true,
        });
      }
    }
  }
  return out;
}

/** Every finger joint, for the quick "is this a hand detail?" checks the
 *  knob sizing and hit gating make. */
export const FINGER_JOINT_IDS: ReadonlySet<JointId> = new Set(
  fingerJoints().map((j) => j.id),
);

/**
 * Rest skeleton, root first (parents always precede children, so a single
 * forward walk resolves world transforms). Proportions measured off the
 * Stewie reference: head ball ~1/5 of standing height, shoulders at ~3/4,
 * long thin arms whose T-pose span is wider than the figure is tall.
 */
export const SKELETON: readonly RestJoint[] = [
  // The root takes a rotation of its own: turning it turns EVERYTHING, so
  // a host can spin the whole figure on any axis from one control (see
  // shape.ts's rotateRig). It has no parent bone to swing about — the
  // translate drag moves it, nothing rotates it by hand.
  { id: 'root', parent: null, dx: 0, dy: 55, dz: 0, posable: true },
  { id: 'spine', parent: 'root', dx: 0, dy: 8, dz: 0, posable: true },
  { id: 'chest', parent: 'spine', dx: 0, dy: 8, dz: 0, posable: true },
  // The COLLAR: the shoulder girdle at the top of the chest. Rotating it
  // see-saws the whole shoulder line (one shoulder up, the other down)
  // about the sternum — and carries the neck and head with it, the way a
  // shoulder tilt leans a real head.
  { id: 'collar', parent: 'chest', dx: 0, dy: 5, dz: 0, posable: true },
  { id: 'neck', parent: 'collar', dx: 0, dy: 2, dz: 0, posable: true },
  { id: 'head', parent: 'neck', dx: 0, dy: 11.8, dz: 0, posable: true },
  { id: 'shoulderL', parent: 'collar', dx: -9.5, dy: 0, dz: 0, posable: true },
  { id: 'shoulderR', parent: 'collar', dx: 9.5, dy: 0, dz: 0, posable: true },
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
  // The FEET: ankle → ball → toe, the one chain that leaves the rig plane
  // (a foot points at the viewer; the stance splay swings it far enough
  // off-axis to stay poseable head-on). The ball is the hinge the toe box
  // bends at; the toe is the chain's draggable end effector.
  { id: 'ballL', parent: 'ankleL', ...footStep(-1, 4.9, -1.1) },
  { id: 'toeL', parent: 'ballL', ...footStep(-1, 4.7, -0.85) },
  { id: 'ballR', parent: 'ankleR', ...footStep(1, 4.9, -1.1) },
  { id: 'toeR', parent: 'ballR', ...footStep(1, 4.7, -0.85) },
  ...fingerJoints(),
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
  /** FINE detail (fingers): offered only when the host says the hand is
   *  big enough on screen to pick one finger from another — see
   *  {@link HAND_SPAN}; hit tests skip fine targets otherwise. */
  fine?: true;
}

export const DRAG_TARGETS: readonly DragTarget[] = [
  { joint: 'root', kind: 'translate' },
  { joint: 'spine', kind: 'fk' },
  { joint: 'chest', kind: 'fk' },
  { joint: 'collar', kind: 'fk' },
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
  // The toe end effector: drag it and the foot reaches — bending at the
  // ball — exactly as a wrist drag bends the elbow.
  { joint: 'toeL', kind: 'ik2', chain: ['ballL', 'toeL'] },
  { joint: 'toeR', kind: 'ik2', chain: ['ballR', 'toeR'] },
  // Every posable finger segment, zoom-gated.
  ...SKELETON.filter((j) => j.posable && FINGER_JOINT_IDS.has(j.id))
    .map((j): DragTarget => ({ joint: j.id, kind: 'fk', fine: true })),
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
  { a: 'collar', b: 'shoulderL', radius: 1.7 },
  { a: 'collar', b: 'shoulderR', radius: 1.7 },
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
  // The feet: heel-to-ball body and the bending toe, as shafts.
  { a: 'ankleL', b: 'ballL', radius: 2.0 },
  { a: 'ballL', b: 'toeL', radius: 1.8 },
  { a: 'ankleR', b: 'ballR', radius: 2.0 },
  { a: 'ballR', b: 'toeR', radius: 1.8 },
  // Fingers: one thin shaft per posable segment, so a curled finger
  // renders curled in the classic look too.
  ...SKELETON.filter((j) => FINGER_JOINT_IDS.has(j.id) && j.posable)
    .map((j): BodyCapsule => ({ a: j.parent!, b: j.id, radius: 0.6 })),
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
  // Hands: the palm in two flat halves — inner riding the mid-palm pin,
  // outer riding the knuckle line — so the classic look bends with the
  // palm effector too.
  { joint: 'palmL', ox: 1.25, oy: 0, oz: 0, rx: 1.9, ry: 1.3, rz: 2.6 },
  { joint: 'palmR', ox: -1.25, oy: 0, oz: 0, rx: 1.9, ry: 1.3, rz: 2.6 },
  { joint: 'knuckL', ox: 1.2, oy: 0, oz: 0, rx: 1.7, ry: 1.35, rz: 2.75 },
  { joint: 'knuckR', ox: -1.2, oy: 0, oz: 0, rx: 1.7, ry: 1.35, rz: 2.75 },
  // Feet: a heel block behind the ankle (the toe half is real bone now —
  // see the foot capsules — so a bent toe shows bent in every look). The
  // foot's length lies toward +z (splayed), which is most of why turning
  // the figure reads as 3D.
  { joint: 'ankleL', ox: 0.95, oy: -3.4, oz: -1.8, rx: 3.0, ry: 2.6, rz: 3.1 },
  { joint: 'ankleR', ox: -0.95, oy: -3.4, oz: -1.8, rx: 3.0, ry: 2.6, rz: 3.1 },
];

/** Grab-knob radius drawn (and hit-tested) at each drag target, rig units.
 *  A whisker larger than the bone under it so the affordance reads. */
export function knobRadius(joint: JointId): number {
  if (joint === 'knuckL' || joint === 'knuckR') return 1.4; // the palm bend
  if (FINGER_JOINT_IDS.has(joint)) return 1.0; // only ever grabbed zoomed in
  switch (joint) {
    case 'root': return 4.2;
    case 'spine': case 'chest': return 3.4;
    case 'collar': return 3.0;
    case 'head': return 3.6;
    case 'toeL': case 'toeR': return 2.0;
    default: return 2.6;
  }
}

// ── Reach ───────────────────────────────────────────────────────────
//
// How far the DRAWING can get from the root — the number the stage is
// sized by, so that no pose and no turn can ever push the figure past the
// viewport that frames it. Bones only rotate about their parents, so a
// joint can never be farther from the root than its chain is long; add
// the flesh hung on it and the bound holds for every pose. Distances are
// 3D, which is what makes it hold for every TURN too: a rotation about
// any axis preserves distance, and projection only shortens it.

/** What the ink shader draws past the flesh — pen half-widths, joint
 *  rings, the chest and pelvis volumes standing a little proud of their
 *  blobs. One generous constant: the stage costs nothing for being a
 *  whisker too big, and clips the figure if it is a whisker too small. */
const INK_ALLOWANCE = 2;

/** Flesh radius per joint: the widest capsule meeting it, any blob riding
 *  it (offset included), and its own grab knob. */
const JOINT_BOUND: ReadonlyMap<JointId, number> = (() => {
  const m = new Map<JointId, number>();
  const bump = (id: JointId, r: number) => m.set(id, Math.max(m.get(id) ?? 0, r));
  for (const c of BODY_CAPSULES) {
    bump(c.a, c.radius);
    bump(c.b, c.radius);
  }
  for (const b of BODY_BLOBS) {
    bump(b.joint, Math.hypot(b.ox, b.oy, b.oz) + Math.max(b.rx, b.ry, b.rz));
  }
  for (const j of SKELETON) bump(j.id, knobRadius(j.id));
  return m;
})();

/** How far the drawn figure reaches past joint `id`, rig units. */
export function jointBound(id: JointId): number {
  return (JOINT_BOUND.get(id) ?? 0) + INK_ALLOWANCE;
}

/** The rest root's height — the figure hangs off it, and the stage is
 *  centred on it. */
export const ROOT_REST_Y = SKELETON[0].dy;

/** The farthest any drawn point can EVER be from the root: the longest
 *  bone chain plus the flesh at its end. No pose can beat it. */
export const MAX_REACH = (() => {
  const chain = new Map<JointId, number>();
  let max = 0;
  for (const j of SKELETON) {
    const d = j.parent
      ? (chain.get(j.parent) ?? 0) + Math.hypot(j.dx, j.dy, j.dz)
      : 0;
    chain.set(j.id, d);
    max = Math.max(max, d + jointBound(j.id));
  }
  return max;
})();
