// Figgie's INK: the NPR shader's hand-drawn construction figure, built as
// pure 2D geometry. Everything the pen draws — tapered wobbly strokes for
// the bones and fingers, an oval head with its face cross curving on the
// ball, the chest, pelvis, palms and feet as solid silhouette-traced
// volumes, circles at the limb joints — is computed here in VIEW space
// (the turned orthographic frame, rig units), then triangulated into one
// flat-colored ribbon batch the renderer uploads and draws in a single
// call. No lighting, no meshes, no 3D shading: a line drawing.
//
// The humanity is DETERMINISTIC: each stroke's bow, wobble and width
// tremor come from hashes of its id, so the same pose under the same turn
// always draws the same figure (renders are on demand and must be
// repeatable), while no two strokes share a character.

import { FiggiePose, WorldJoints, defaultPose, solveWorld } from './pose';
import { FINGER_NAMES, FOOT_SPLAY, JointId, knobRadius } from './skeleton';
import { quatRotate } from './quat';
import { TurnLike, projectTurn, turnQuat } from './view';

export interface InkPoint {
  x: number;
  y: number;
  /** View depth (projectTurn's pz; toward the viewer positive) — strokes
   *  are depth-tested against the solid body masses. */
  z: number;
  /** Half-width of the ribbon at this point, rig units. */
  w: number;
}

export interface InkStroke {
  /** Stable name ('chest', 'armL1', 'face-eye', …) — seeds the stroke's
   *  hand-drawn character and keys the tests. */
  id: string;
  closed: boolean;
  points: InkPoint[];
}

/** A solid body mass: a convex polygon the renderer fills DEPTH-ONLY, so
 *  the page still shows through the figure while strokes passing behind
 *  the mass are occluded — a drawn shape hides what's behind it. */
export interface InkFill {
  id: string;
  points: Array<{ x: number; y: number; z: number }>;
}

export interface InkBatch {
  /** Interleaved x, y, z per vertex (view space, rig units). */
  positions: Float32Array;
  indices: Uint16Array;
}

export interface InkDraw {
  main: InkBatch;
  /** The solid masses (chest, pelvis, palms, feet, head), drawn
   *  depth-only FIRST. */
  fills: InkBatch;
  /** The active joint's marker (a bold accent ring), drawn over the ink. */
  accent: InkBatch | null;
}

// ── The pen ─────────────────────────────────────────────────────────

/** Ideal spacing between ribbon samples, rig units — fine enough that the
 *  wobble and tremor sines stay smooth curves (undersampled they alias
 *  into beads along the stroke). */
const SAMPLE_STEP = 1.5;
/** How far past its start a closed stroke draws — the visible pen seam
 *  every hand-drawn loop has. */
const CLOSE_OVERLAP = 0.06;

/** Deterministic [0, 1): FNV over the seed, mixed with the lane `k`. */
function hash01(seed: string, k: number): number {
  let h = (2166136261 ^ Math.imul(k + 1, 0x9e3779b9)) >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

interface P2 { x: number; y: number; z: number }

/** Point `s` along a polyline (2D arc length; z rides), clamped to its
 *  ends. */
function polyAt(poly: readonly P2[], lens: readonly number[], s: number): P2 {
  let rest = Math.max(0, s);
  for (let i = 0; i < lens.length; i++) {
    if (rest <= lens[i] || i === lens.length - 1) {
      const t = lens[i] > 1e-9 ? Math.min(1, rest / lens[i]) : 0;
      return {
        x: poly[i].x + (poly[i + 1].x - poly[i].x) * t,
        y: poly[i].y + (poly[i + 1].y - poly[i].y) * t,
        z: poly[i].z + (poly[i + 1].z - poly[i].z) * t,
      };
    }
    rest -= lens[i];
  }
  return poly[poly.length - 1];
}

/** Hermite ease, clamped — every pressure transition runs through this so
 *  the width never kinks. */
function smooth01(u: number): number {
  const c = Math.min(1, Math.max(0, u));
  return c * c * (3 - 2 * c);
}

/** The nib's pressure along the stroke. `start` is THIS stroke's
 *  touch-down pressure (per-stroke noise — lines start at slightly
 *  different thicknesses), easing smoothly to full over the first fifth;
 *  an open stroke then tapers smoothly out to a point — the pen lifting
 *  away. Closed shapes ease both ends the same gentle way, so the seam
 *  reads as a drawn-over join rather than a chopped ribbon. */
function profile(t: number, taperEnd: boolean, start: number): number {
  const attack = start + (1 - start) * smooth01(t / 0.2);
  if (!taperEnd) return attack * (start + (1 - start) * smooth01((1 - t) / 0.2));
  return attack * (1 - 0.86 * smooth01((t - 0.5) / 0.5) ** 1.25);
}

/**
 * Draw one stroke: resample the guide polyline evenly, then give it a
 * hand — a gentle per-stroke bow, two sine wobbles, a width tremor, and
 * the taper. Open strokes stay anchored at their endpoints (they must
 * still meet their joints) and taper toward the END; closed ones wrap
 * with a small overlap and keep their width. A guide shorter than a pen
 * dab produces no points (the batch skips it).
 */
function pen(
  id: string,
  guide: readonly P2[],
  closed: boolean,
  width: number,
): InkStroke {
  const poly = closed ? [...guide, guide[0]] : [...guide];
  const lens: number[] = [];
  let total = 0;
  for (let i = 0; i < poly.length - 1; i++) {
    const l = Math.hypot(poly[i + 1].x - poly[i].x, poly[i + 1].y - poly[i].y);
    lens.push(l);
    total += l;
  }
  if (total < 0.8) return { id, closed, points: [] };

  const span = closed ? total * (1 + CLOSE_OVERLAP) : total;
  const n = Math.max(9, Math.min(56, Math.round(span / SAMPLE_STEP) + 1));
  const base: P2[] = [];
  for (let i = 0; i < n; i++) {
    const s = (span * i) / (n - 1);
    base.push(polyAt(poly, lens, closed ? s % total : s));
  }

  // The stroke's character, all from its name. The PATH wanders only
  // gently (a steady hand); it is the WIDTH that carries most of the
  // noise — real pen lines run truer in position than in pressure.
  const amp = Math.min(0.3, total * 0.009);
  const bow = (hash01(id, 1) - 0.5) * 2 * Math.min(0.7, total * 0.013);
  const f1 = 0.8 + total / 22;
  const f2 = f1 * 2.3;
  const p1 = hash01(id, 2);
  const p2 = hash01(id, 3);
  const p3 = hash01(id, 4);
  const p4 = hash01(id, 5);
  const start = 0.62 + 0.5 * hash01(id, 6);

  const points: InkPoint[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const prev = base[Math.max(0, i - 1)];
    const next = base[Math.min(n - 1, i + 1)];
    let dx = next.x - prev.x;
    let dy = next.y - prev.y;
    const dl = Math.hypot(dx, dy);
    if (dl > 1e-9) {
      dx /= dl;
      dy /= dl;
    } else {
      dx = 1;
      dy = 0;
    }
    // Perpendicular deviation: wobble everywhere, bow on open strokes,
    // pinched to nothing at open ends so joints still connect.
    const env = closed ? 1 : 0.15 + 0.85 * Math.sin(Math.PI * t) ** 0.6;
    const wob = env * (
      amp * (0.6 * Math.sin(2 * Math.PI * (f1 * t + p1))
        + 0.4 * Math.sin(2 * Math.PI * (f2 * t + p2)))
      + (closed ? 0 : bow * Math.sin(Math.PI * t))
    );
    // Pressure runs nearly steady mid-stroke — the stroke-to-stroke
    // variety lives in `start` — so the taper reads as one smooth lift.
    const tremor = 1
      + 0.05 * Math.sin(2 * Math.PI * (f1 * 0.9 * t + p3))
      + 0.03 * Math.sin(2 * Math.PI * (f2 * 1.3 * t + p4));
    points.push({
      x: base[i].x - dy * wob,
      y: base[i].y + dx * wob,
      z: base[i].z,
      w: Math.max(0.1, width * profile(t, !closed, start) * tremor),
    });
  }
  return { id, closed, points };
}

/** The ribbon's two edge points at sample `i`: the centerline offset ±
 *  its half-width, perpendicular to the local direction. The one place
 *  the ribbon's shape is defined — the GL batch and the vector bake both
 *  extrude through here, so a baked figure and a drawn one are the same
 *  drawing. */
function ribbonEdges(
  pts: readonly InkPoint[],
  i: number,
): [{ x: number; y: number }, { x: number; y: number }] {
  const prev = pts[Math.max(0, i - 1)];
  const next = pts[Math.min(pts.length - 1, i + 1)];
  let dx = next.x - prev.x;
  let dy = next.y - prev.y;
  const dl = Math.hypot(dx, dy);
  if (dl > 1e-9) {
    dx /= dl;
    dy /= dl;
  } else {
    dx = 1;
    dy = 0;
  }
  const p = pts[i];
  return [
    { x: p.x - dy * p.w, y: p.y + dx * p.w },
    { x: p.x + dy * p.w, y: p.y - dx * p.w },
  ];
}

/** Triangulate strokes into one ribbon batch: each point extrudes ± its
 *  half-width perpendicular to the local direction; consecutive pairs
 *  join as quads. Strokes the pen skipped contribute nothing. */
export function inkBatch(strokes: readonly InkStroke[]): InkBatch {
  let verts = 0;
  let tris = 0;
  for (const s of strokes) {
    if (s.points.length < 2) continue;
    verts += s.points.length * 2;
    tris += (s.points.length - 1) * 2;
  }
  const positions = new Float32Array(verts * 3);
  const indices = new Uint16Array(tris * 3);
  let v = 0;
  let x = 0;
  for (const s of strokes) {
    const pts = s.points;
    if (pts.length < 2) continue;
    const first = v / 3;
    for (let i = 0; i < pts.length; i++) {
      const [a, b] = ribbonEdges(pts, i);
      positions[v++] = a.x;
      positions[v++] = a.y;
      positions[v++] = pts[i].z;
      positions[v++] = b.x;
      positions[v++] = b.y;
      positions[v++] = pts[i].z;
    }
    for (let i = 0; i < pts.length - 1; i++) {
      const a = first + i * 2;
      indices[x++] = a;
      indices[x++] = a + 1;
      indices[x++] = a + 2;
      indices[x++] = a + 2;
      indices[x++] = a + 1;
      indices[x++] = a + 3;
    }
  }
  return { positions, indices };
}

/** Triangulate the solid masses: each is a convex polygon, fanned from
 *  its first vertex. */
export function fillBatch(fills: readonly InkFill[]): InkBatch {
  let verts = 0;
  let tris = 0;
  for (const f of fills) {
    if (f.points.length < 3) continue;
    verts += f.points.length;
    tris += f.points.length - 2;
  }
  const positions = new Float32Array(verts * 3);
  const indices = new Uint16Array(tris * 3);
  let v = 0;
  let x = 0;
  for (const f of fills) {
    if (f.points.length < 3) continue;
    const first = v / 3;
    for (const p of f.points) {
      positions[v++] = p.x;
      positions[v++] = p.y;
      positions[v++] = p.z;
    }
    for (let i = 1; i < f.points.length - 1; i++) {
      indices[x++] = first;
      indices[x++] = first + i;
      indices[x++] = first + i + 1;
    }
  }
  return { positions, indices };
}

// ── The figure ──────────────────────────────────────────────────────

/** Half-widths, rig units (a stroke's FULL width is twice these). */
const LIMB_W = 1.05;
const SPINE_W = 1.0;
const SHAPE_W = 0.85;
const CIRCLE_W = 0.5;
const FACE_W = 0.62;

/** The head oval — slightly narrower than tall, like a drawn construction
 *  ball (the classic head ball is a 10.2 sphere; the oval hugs it). */
const HEAD_RX = 9.2;
const HEAD_RY = 10.8;
/** The sphere the face cross curves on. */
const FACE_R = 9.4;
/** Eye-line latitude on that sphere (the eyes sit just above center). */
const EYE_Y = 1.2;
/** How far around the ball each face line is DRAWN, radians from the
 *  front pole. The cross marks the FACE, not a ring around the skull —
 *  restricting the drawn arc is also what lets it vanish behind the
 *  silhouette as the head turns away. */
const EYE_ARC = 1.35;

/** A silhouette vertex BOUND to a joint: the joint whose posed frame
 *  carries it, then the local (x, y, z) offset. Binding different rims of
 *  one volume to different joints is the skinning that lets a single
 *  solid bend.
 *
 *  A vertex may also be WEIGHTED toward a second joint — `toward` and `w`,
 *  0 = all the first joint, 1 = all the second. That is the difference
 *  between a rim that kinks at a joint and one that curves through it: a
 *  run of vertices whose weights climb from 0 to 1 hands the surface over
 *  smoothly, so the shape shears rather than folding at one seam. */
type BoundVert = [JointId, number, number, number, JointId?, number?];

/** The chest: ONE solid, skinned. Its bottom rim is bound to the chest
 *  joint and a mid rim — the waistline — with it, so a collar tilt shears
 *  the box and kinks its sides there instead of splitting it into two
 *  shapes. Turned, the hull traces the box's outline.
 *
 *  Its TOP is a shallow DOME, and the dome is where the shoulders live.
 *  The rim runs sternum → mid → corner on each side with the weight
 *  climbing 0 → 0.8 → 1 from the collar onto that side's SHOULDER, so
 *  pulling one shoulder up or down carries the chest's top surface with
 *  it: at the shoulder the rim goes the whole way, at the sternum not at
 *  all, and between them it bends. The middle vertex takes most of the
 *  shoulder's travel (0.8, not the 0.6 its position would suggest) because
 *  the corner swings on an ARC — it rises faster than a straight blend
 *  predicts, and a mid vertex that lagged it would sink inside the outline
 *  and leave a flat bevel where the curve should be.
 *
 *  A flat top could show none of this: it would read as one rigid lid
 *  however far the shoulders travelled, which is why the rim domes at rest
 *  rather than ruling straight across. */
const CHEST_BINDS: ReadonlyArray<BoundVert> = [
  // Top rim, rel collar (5 above the chest joint) — front face then back.
  ['collar', 0, 2.8, 3.6],
  ['collar', -3.6, 2.64, 3.6, 'shoulderL', 0.52], ['collar', 3.6, 2.64, 3.6, 'shoulderR', 0.52],
  ['collar', -6.4, 2.2, 3.6, 'shoulderL', 0.9], ['collar', 6.4, 2.2, 3.6, 'shoulderR', 0.9],
  ['collar', -8.2, 1.2, 3.6, 'shoulderL', 1], ['collar', 8.2, 1.2, 3.6, 'shoulderR', 1],
  ['collar', 0, 2.8, -3.6],
  ['collar', -3.6, 2.64, -3.6, 'shoulderL', 0.52], ['collar', 3.6, 2.64, -3.6, 'shoulderR', 0.52],
  ['collar', -6.4, 2.2, -3.6, 'shoulderL', 0.9], ['collar', 6.4, 2.2, -3.6, 'shoulderR', 0.9],
  ['collar', -8.2, 1.2, -3.6, 'shoulderL', 1], ['collar', 8.2, 1.2, -3.6, 'shoulderR', 1],
  // Mid rim (the bend's waistline), rel chest.
  ['chest', -7.1, -2.15, 3.3], ['chest', 7.1, -2.15, 3.3],
  ['chest', -7.1, -2.15, -3.3], ['chest', 7.1, -2.15, -3.3],
  // Bottom rim, rel chest.
  ['chest', -6.0, -10.5, 3.0], ['chest', 6.0, -10.5, 3.0],
  ['chest', -6.0, -10.5, -3.0], ['chest', 6.0, -10.5, -3.0],
];
/** Pelvis VOLUME — the drawn bowl the legs hang from, a shield with depth
 *  (wider rim, narrowing toward its point), authored in the ROOT's frame.
 *
 *  Each SIDE of the shield is carried by the hip on that side, the middle
 *  by the root. At rest and under every pose that is the same shield: the
 *  hips are rigid corners of the pelvis (SKELETON, `posable: false`), so
 *  their frame and the root's differ by a fixed translation and the
 *  skinning is exactly a change of coordinates. It matters under the PUSH
 *  brush, which is the one thing that can move a hip on its own: the flesh
 *  round the leg goes down with the leg, so a lengthened leg still comes
 *  out of a hip instead of hanging below a shield nailed to the root the
 *  brush deliberately never moves. */
const PELVIS_BINDS: ReadonlyArray<BoundVert> = [
  ['root', -6.8, 0.8, 3.0, 'hipL', 1], ['root', -6.8, 0.8, -3.0, 'hipL', 1],
  ['root', 0, 1.5, 3.2], ['root', 0, 1.5, -3.2],
  ['root', 6.8, 0.8, 3.0, 'hipR', 1], ['root', 6.8, 0.8, -3.0, 'hipR', 1],
  ['root', 4.4, -4.8, 2.2, 'hipR', 1], ['root', 4.4, -4.8, -2.2, 'hipR', 1],
  ['root', 0, -7.6, 1.6], ['root', 0, -7.6, -1.6],
  ['root', -4.4, -4.8, 2.2, 'hipL', 1], ['root', -4.4, -4.8, -2.2, 'hipL', 1],
];
/** The palm: ONE solid, skinned — the chest's arrangement at hand scale.
 *  LEFT-authored (x mirrors for the right, and the joint names take the
 *  side), three rims from the wrist out:
 *
 *   - the INNER rim rides the mid-palm pin (`palmL`, 3.8 out from the
 *     wrist), starting beyond the wrist's drawn circle so the joint sits
 *     before the volume rather than inside it;
 *   - the MID rim sits ON the pin and rides the knuckle line (`knuckL`) —
 *     at the hinge itself, so it holds still while the outer half swings;
 *   - the OUTER rim is the knuckle line, where the fingers hang.
 *
 *  Bending the palm effector therefore SHEARS one box and kinks its sides
 *  at the pin, instead of hinging two separate shapes apart — the same
 *  reason the chest is one skinned solid and not a stack of two.
 *
 *  The palm is a little shorter than it was: the wrist-side rim starts
 *  2.1 out rather than 1.3, which frees the wrist circle and leaves the
 *  hand reading as a hand rather than a paddle. */
type PalmVert = ['palm' | 'knuck', number, number, number];

const PALM_BINDS: ReadonlyArray<PalmVert> = [
  // Inner rim (wrist end), rel the pin.
  ['palm', 1.7, 2.55, 1.35], ['palm', 1.7, 2.55, -1.35],
  ['palm', 1.7, -2.25, 1.35], ['palm', 1.7, -2.25, -1.35],
  // Mid rim — the hinge line, ON the pin, rel the knuckle line.
  ['knuck', 2.5, 2.65, 1.4], ['knuck', 2.5, 2.65, -1.4],
  ['knuck', 2.5, -2.35, 1.4], ['knuck', 2.5, -2.35, -1.4],
  // Outer rim: the knuckle line itself.
  ['knuck', 0, 2.7, 1.4], ['knuck', 0, 2.7, -1.4],
  ['knuck', 0, -2.4, 1.4], ['knuck', 0, -2.4, -1.4],
];

/** `PALM_BINDS` for one hand: the joints take the side, and the right
 *  hand's x mirrors (the table is authored left, x running back toward
 *  the wrist). */
function palmBinds(side: 'L' | 'R'): BoundVert[] {
  const mx = side === 'L' ? 1 : -1;
  return PALM_BINDS.map(([joint, x, y, z]): BoundVert => [
    `${joint}${side}` as JointId, mx * x, y, z,
  ]);
}
/** The hand draws with a LIGHTER pen: the palm outline at half the body's
 *  stroke weight, so the detail stays legible at hand scale. The FINGERS
 *  carry a quarter more than that — five thin lines side by side read as
 *  hatching rather than as fingers when they are as fine as the palm. */
const HAND_W = SHAPE_W * 0.5;
const FINGER_W = 0.35;
/** Foot VOLUMES, tapered rectangular solids in the foot chain's splayed
 *  rest frames: the BODY spans heel to ball (anchored at the ball joint,
 *  so a swing at the heel pitches it about the ankle and a swing at the
 *  ball lifts it off the heel) and the TOE box spans ball to tip (anchored
 *  at the toe joint — the skinning that lets the foot bend at the ball).
 *  Corners are authored in the unsplayed frame (x across, y up, z forward)
 *  and splay-rotated once at module init.
 *
 *  Both boxes STRADDLE the joint they hang off: the L drops the foot's
 *  bones down into the flesh, so the ball sits well inside the body's face
 *  rather than perched on its top edge, where it used to. The boxes
 *  themselves have not moved a hair — the same drawn foot, re-hung on the
 *  joints' new places, so the sketch still lands where the classic bake
 *  does. What connects the ankle down to all this is the heel stroke, the
 *  L's upright. */
const FOOT_BODY_RAW: ReadonlyArray<[number, number, number]> = [
  [-2.34, 1.94, 0], [2.34, 1.94, 0], [-2.34, -1.0, 0], [2.34, -1.0, 0],
  [-1.68, 1.94, -8.04], [1.68, 1.94, -8.04], [-1.68, -1.0, -8.04], [1.68, -1.0, -8.04],
];
const TOE_BOX_RAW: ReadonlyArray<[number, number, number]> = [
  [-1.92, 1.71, 1.08], [1.92, 1.71, 1.08], [-1.92, -1.05, 1.08], [1.92, -1.05, 1.08],
  [-2.34, 2.12, -4.68], [2.34, 2.12, -4.68], [-2.34, -0.82, -4.68], [2.34, -0.82, -4.68],
];

function splayVolume(
  raw: ReadonlyArray<[number, number, number]>,
  angle: number,
): Array<[number, number, number]> {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return raw.map(([x, y, z]) => [x * cos + z * sin, y, -x * sin + z * cos]);
}

const FOOT_BODY_L = splayVolume(FOOT_BODY_RAW, -FOOT_SPLAY);
const FOOT_BODY_R = splayVolume(FOOT_BODY_RAW, FOOT_SPLAY);
const TOE_BOX_L = splayVolume(TOE_BOX_RAW, -FOOT_SPLAY);
const TOE_BOX_R = splayVolume(TOE_BOX_RAW, FOOT_SPLAY);

/** The elbow circle's radius — also the reference the fingertip marks
 *  are sized against. */
const ELBOW_CIRCLE_R = 1.5;

/** The limb joints that get a drawn circle: radius, and optionally a
 *  lighter pen (defaults to CIRCLE_W). The toe effector deliberately has
 *  NONE at rest — the foot stays clean — and surfaces as a blue circle
 *  only while grabbed (buildInkDraw's accent fallback covers every
 *  circle-less joint). */
const JOINT_CIRCLES: ReadonlyArray<[JointId, number, number?]> = [
  ['shoulderL', 1.7], ['shoulderR', 1.7],
  ['elbowL', ELBOW_CIRCLE_R], ['elbowR', ELBOW_CIRCLE_R],
  ['wristL', 1.25], ['wristR', 1.25],
  ['kneeL', 1.7], ['kneeR', 1.7],
  ['ankleL', 1.25], ['ankleR', 1.25],
];

/** Fingertip end-effector marks: a tiny ring on each tip, 30% of the
 *  elbow circle's size, drawn with a matching featherweight pen. */
const FINGERTIP_CIRCLES: ReadonlyArray<[JointId, number, number]> =
  (['L', 'R'] as const).flatMap((side) =>
    FINGER_NAMES.map((name): [JointId, number, number] =>
      [`${name}${side}3` as JointId, ELBOW_CIRCLE_R * 0.3, 0.16]));

/** How far behind their outlines the solid masses sit (view z, rig
 *  units): deep enough that a shape's own strokes — its outline, the
 *  spine through the chest, the face cross — always win the depth test,
 *  shallow enough that anything genuinely behind the body is hidden. */
const FILL_BIAS = 1.2;

/** A billboarded circle/ellipse guide in view space, at depth `z`. */
function ovalGuide(
  cx: number, cy: number, z: number, rx: number, ry: number, steps: number,
): P2[] {
  const pts: P2[] = [];
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    pts.push({ x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry, z });
  }
  return pts;
}

/**
 * The whole figure as ink strokes, in the view frame of `turn`:
 *
 *  - spine (root→spine→chest) and neck, the torso's center line;
 *  - one tapered stroke per limb bone;
 *  - the chest RECTANGLE and pelvis SHIELD as closed shapes, riding their
 *    joints' rotations;
 *  - the head as a billboarded oval, with the face cross — eye line and
 *    center line — sampled ON the head sphere in 3D, so the curves match
 *    the face's surface, slide around it as the figure turns, and
 *    disappear when the head faces away;
 *  - a small hand-drawn circle at each limb joint;
 *  - triangle hands and splayed wedge feet, riding their joints.
 */
/** 2D convex hull (monotone chain), counter-clockwise. The masses are
 *  convex volumes, so the hull of their projected corners IS their
 *  screen-space silhouette. */
function convexHull(pts: readonly P2[]): P2[] {
  const s = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: P2, a: P2, b: P2) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: P2[] = [];
  for (const p of s) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: P2[] = [];
  for (let i = s.length - 1; i >= 0; i--) {
    const p = s[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** A body mass's screen-space silhouette under the current view: the hull
 *  of its projected corners, flattened to the volume's centre depth (its
 *  own outline and interior lines must beat the fill, which sits
 *  {@link FILL_BIAS} further back — exactly the head's arrangement). */
interface MassSilhouette {
  id: string;
  /** Hull guide, every point at the mass's centre depth. */
  guide: P2[];
  /** Where the depth-only fill sits. */
  fillZ: number;
  /** The outline's pen half-width (the hands draw lighter). */
  width: number;
}

/** Rest positions of every joint — what a weighted vertex's offset in its
 *  SECOND bind frame is measured from. Both frames rest unrotated, so the
 *  change of frame is the plain translation between the two joints. */
const REST_JOINTS: WorldJoints = solveWorld(defaultPose());

function massSilhouettes(
  world: WorldJoints,
  turn: TurnLike,
): MassSilhouette[] {
  const { L } = frameOf(world, turn);
  /** One bound vertex, projected. A weighted vertex is carried by BOTH
   *  frames and blended between them — linear blend skinning, done on the
   *  projected points because the projection is affine and cannot tell the
   *  difference. */
  const skin = ([joint, x, y, z, toward, w]: BoundVert): P2 => {
    const a = L(joint, x, y, z);
    if (toward === undefined || !w) return a;
    const from = REST_JOINTS[joint];
    const onto = REST_JOINTS[toward];
    const b = L(toward, x + from.x - onto.x, y + from.y - onto.y, z + from.z - onto.z);
    return {
      x: a.x + (b.x - a.x) * w,
      y: a.y + (b.y - a.y) * w,
      z: a.z + (b.z - a.z) * w,
    };
  };
  const make = (
    id: string,
    binds: ReadonlyArray<BoundVert>,
    width = SHAPE_W,
  ): MassSilhouette => {
    const proj = binds.map(skin);
    const zc = proj.reduce((s, p) => s + p.z, 0) / proj.length;
    const guide = convexHull(proj).map((p) => ({ x: p.x, y: p.y, z: zc }));
    return { id, guide, fillZ: zc - FILL_BIAS, width };
  };
  /** A whole volume riding one joint — the unskinned masses. */
  const box = (
    joint: JointId,
    volume: ReadonlyArray<[number, number, number]>,
  ): BoundVert[] => volume.map(([x, y, z]): BoundVert => [joint, x, y, z]);
  return [
    make('chest', CHEST_BINDS),
    make('pelvis', PELVIS_BINDS),
    // One skinned solid per hand: the palm bends at its pin rather than
    // coming apart into an inner and an outer plate.
    make('handL', palmBinds('L'), HAND_W),
    make('handR', palmBinds('R'), HAND_W),
    // Foot body rides the ball joint (a heel swing pitches it about the
    // ankle, a ball swing lifts it off the heel); the toe box rides the
    // toe joint, so a toe drag bends the foot at the ball — solid follows
    // bone, drawn skinning.
    make('footL', box('ballL', FOOT_BODY_L)),
    make('footR', box('ballR', FOOT_BODY_R)),
    make('toeL', box('toeL', TOE_BOX_L)),
    make('toeR', box('toeR', TOE_BOX_R)),
  ];
}

/** The projection helpers strokes and fills share: world → view (`P`), a
 *  joint's view position (`J`), and a local offset carried by a joint's
 *  posed frame (`L`). */
function frameOf(world: WorldJoints, turn: TurnLike) {
  const q = turnQuat(turn);
  const pivotX = world.root.x;
  const pivotY = world.root.y;
  const P = (x: number, y: number, z: number): P2 => {
    const p = projectTurn(x, y, z, q, pivotX, pivotY);
    return { x: p.px, y: p.py, z: p.pz };
  };
  const J = (id: JointId): P2 => P(world[id].x, world[id].y, world[id].z);
  const L = (joint: JointId, lx: number, ly: number, lz: number): P2 => {
    const j = world[joint];
    const [ox, oy, oz] = quatRotate(j.rot, lx, ly, lz);
    return P(j.x + ox, j.y + oy, j.z + oz);
  };
  return { q, P, J, L };
}

export function sketchInk(
  pose: FiggiePose,
  turn: TurnLike,
  world: WorldJoints = solveWorld(pose),
): InkStroke[] {
  const { q, P, J } = frameOf(world, turn);

  const out: InkStroke[] = [];
  const line = (id: string, a: P2, b: P2, w: number) => {
    out.push(pen(id, [a, b], false, w));
  };

  // Torso center line and the neck's short riser toward the head ball.
  out.push(pen('spine', [J('root'), J('spine'), J('chest')], false, SPINE_W));
  const head = world.head;
  const neck = world.neck;
  const toHead = Math.hypot(head.x - neck.x, head.y - neck.y, head.z - neck.z) || 1;
  line('neck', J('neck'), P(
    head.x + ((neck.x - head.x) / toHead) * (HEAD_RY - 0.6),
    head.y + ((neck.y - head.y) / toHead) * (HEAD_RY - 0.6),
    head.z + ((neck.z - head.z) / toHead) * (HEAD_RY - 0.6),
  ), SPINE_W);

  // Limbs: one tapered stroke per bone, thinning into the next joint.
  line('armL0', J('shoulderL'), J('elbowL'), LIMB_W);
  line('armL1', J('elbowL'), J('wristL'), LIMB_W);
  line('armR0', J('shoulderR'), J('elbowR'), LIMB_W);
  line('armR1', J('elbowR'), J('wristR'), LIMB_W);
  line('legL0', J('hipL'), J('kneeL'), LIMB_W);
  line('legL1', J('kneeL'), J('ankleL'), LIMB_W);
  line('legR0', J('hipR'), J('kneeR'), LIMB_W);
  line('legR1', J('kneeR'), J('ankleR'), LIMB_W);
  // The L's upright: the short drop from the ankle into the heel, which is
  // what carries the drawn leg down into the foot box instead of leaving
  // the ankle circle hovering over it.
  line('heelL', J('ankleL'), J('heelL'), LIMB_W);
  line('heelR', J('ankleR'), J('heelR'), LIMB_W);

  // The two closed body masses, each drawn as its VIEW-dependent
  // silhouette — the projected hull of the volume — so a turned chest
  // shows the side of the box, not a collapsed line.
  for (const mass of massSilhouettes(world, turn)) {
    out.push(pen(mass.id, mass.guide, true, mass.width));
  }

  // The head oval, billboarded — a drawn circle always shows its round.
  const headC = J('head');
  out.push(pen('head', ovalGuide(headC.x, headC.y, headC.z, HEAD_RX, HEAD_RY, 18), true, SHAPE_W));

  // The face cross, on the ball's surface. Each is sampled in the head's
  // LOCAL frame, carried by its posed rotation, and kept only where the
  // sphere's surface faces the viewer — so the lines curve with the face,
  // wrap as the figure turns, and vanish when it turns away.
  const faceArc = (
    id: string,
    local: (t: number) => [number, number, number],
    steps: number,
    w: number,
  ) => {
    const run: P2[] = [];
    for (let i = 0; i <= steps; i++) {
      const [lx, ly, lz] = local(i / steps);
      const [ox, oy, oz] = quatRotate(world.head.rot, lx, ly, lz);
      const r = Math.hypot(ox, oy, oz) || 1;
      const [, , nz] = quatRotate(q, ox / r, oy / r, oz / r);
      if (nz > 0.1) {
        run.push(P(head.x + ox, head.y + oy, head.z + oz));
      } else if (run.length >= 3) {
        break; // the visible arc ended — keep the first contiguous run
      } else {
        run.length = 0;
      }
    }
    if (run.length >= 3) out.push(pen(id, run, false, w));
  };
  const eyeR = Math.sqrt(FACE_R * FACE_R - EYE_Y * EYE_Y);
  faceArc('face-eye', (t) => {
    const a = -EYE_ARC + t * 2 * EYE_ARC;
    return [eyeR * Math.sin(a), EYE_Y, eyeR * Math.cos(a)];
  }, 24, FACE_W);
  faceArc('face-center', (t) => {
    const a = -0.7 + t * 1.55;
    return [0, FACE_R * Math.sin(a), FACE_R * Math.cos(a)];
  }, 20, FACE_W);

  // Hand-drawn circles at the limb joints.
  for (const [joint, r, w] of [...JOINT_CIRCLES, ...FINGERTIP_CIRCLES]) {
    const c = J(joint);
    out.push(pen(`joint-${joint}`, ovalGuide(c.x, c.y, c.z, r, r, 12), true, w ?? CIRCLE_W));
  }

  // Fingers: one tapered stroke per finger, drawn as a polyline through
  // its whole chain — base knuckle on the palm rim, then the three posed
  // segments — so a curled finger draws curled at every knuckle. (The
  // palm solids and foot boxes are masses; massSilhouettes draws them.)
  for (const side of ['L', 'R'] as const) {
    for (const name of FINGER_NAMES) {
      out.push(pen(
        `finger-${name}${side}`,
        [0, 1, 2, 3].map((i) => J(`${name}${side}${i}` as JointId)),
        false,
        FINGER_W,
      ));
    }
  }

  return out;
}

/**
 * The SOLID body masses: chest rectangle, pelvis shield, head oval and the
 * limb joints' circles as convex polygons, pushed {@link FILL_BIAS} behind
 * their outlines. The renderer fills them depth-only, so the page still
 * shows through the figure while strokes passing genuinely behind a mass —
 * a far arm on a turned figure — are hidden, the way a drawn solid hides
 * what's behind it. Each shape's OWN strokes sit in front of its fill by
 * construction.
 *
 * A JOINT CIRCLE is a solid too. It is drawn as a ball at the end of a
 * bone, and a ball is not see-through: leaving it hollow let the far arm's
 * stroke run straight across an elbow, and a limb pointing away from the
 * viewer poked out through the very joint it hangs from. The disc fills to
 * the circle's guide radius — the centre line of the pen's band, not its
 * outer edge — so the cut always lands UNDER the drawn ring rather than
 * beside it. The fingertip rings are left hollow: they are end-effector
 * marks rather than drawn joints, and at 0.45 units they would clip more
 * than they cover.
 */
export function sketchFills(
  pose: FiggiePose,
  turn: TurnLike,
  world: WorldJoints = solveWorld(pose),
): InkFill[] {
  const { J } = frameOf(world, turn);
  const headC = J('head');
  return [
    // The masses fill their own screen-space silhouettes — the same hulls
    // their outlines trace — at the biased depth.
    ...massSilhouettes(world, turn).map((m) => ({
      id: m.id,
      points: m.guide.map((p) => ({ x: p.x, y: p.y, z: m.fillZ })),
    })),
    // Slightly inside the drawn oval, so the wobbling outline always
    // overhangs its own solid.
    {
      id: 'head',
      points: ovalGuide(
        headC.x, headC.y, headC.z - FILL_BIAS, HEAD_RX - 0.4, HEAD_RY - 0.4, 20,
      ),
    },
    ...JOINT_CIRCLES.map(([joint, r]) => {
      const c = J(joint);
      return { id: `joint-${joint}`, points: ovalGuide(c.x, c.y, c.z - FILL_BIAS, r, r, 12) };
    }),
  ];
}

/**
 * Everything the renderer draws for one NPR frame: the solid masses
 * (depth-only, first), the figure's ink, and the held joint's feedback.
 *
 * That feedback is the joint's OWN drawn circle turned accent-blue — the
 * same stroke, the same size, lifted out of the ink batch and into the
 * accent one, which the renderer draws last with depth off. So a grabbed
 * joint recolors rather than gaining a second ring, and a joint buried in
 * a solid mass (the chest knob inside its rectangle) surfaces while held.
 * Joints with no drawn circle (root, spine, chest, head, fingertips) get
 * a circle in the same modest style, sized to their knob.
 */
export function buildInkDraw(
  pose: FiggiePose,
  turn: TurnLike,
  activeJoint: JointId | null,
): InkDraw {
  const world = solveWorld(pose);
  const strokes = sketchInk(pose, turn, world);
  const fills = fillBatch(sketchFills(pose, turn, world));
  if (!activeJoint) return { main: inkBatch(strokes), fills, accent: null };
  const own = strokes.find((s) => s.id === `joint-${activeJoint}`);
  const marker = own ?? (() => {
    const { J } = frameOf(world, turn);
    const c = J(activeJoint);
    const r = knobRadius(activeJoint) * 0.62;
    return pen(`joint-${activeJoint}`, ovalGuide(c.x, c.y, c.z, r, r, 12), true, CIRCLE_W);
  })();
  return {
    main: inkBatch(own ? strokes.filter((s) => s !== own) : strokes),
    fills,
    accent: inkBatch([marker]),
  };
}

// ── The vector bake ─────────────────────────────────────────────────
//
// The GL path hides what passes behind a body mass with a depth buffer:
// the masses fill depth-only, the ink draws depth-tested. A vector bake —
// a page thumbnail, an exported image, anything drawn without a GL
// context — has no depth buffer, so the same occlusion is resolved here,
// on the CPU, before the ribbons become polygons: each mass is a convex
// silhouette at ONE depth (massSilhouettes flattens it), so a stroke
// sample is hidden exactly when some nearer mass's hull contains it. A
// stroke that dips behind the chest comes out as two polygons with the
// gap the mannequin's body would have made.

/** A visible run of one stroke, as a closed polygon in view space (rig
 *  units) ready to FILL — the ribbon the GL path triangulates, outlined.
 *  `id` is the stroke's name, repeated when a stroke is clipped in two. */
export interface InkPoly {
  id: string;
  points: Array<{ x: number; y: number }>;
}

/** Is (x, y) inside this convex polygon? Winding-agnostic: every edge
 *  cross-product must share a sign (zeros — a point on an edge — count as
 *  inside either way). */
function pointInConvex(
  poly: ReadonlyArray<{ x: number; y: number }>,
  x: number,
  y: number,
): boolean {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const c = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
    if (c > 1e-9) {
      if (sign < 0) return false;
      sign = 1;
    } else if (c < -1e-9) {
      if (sign > 0) return false;
      sign = -1;
    }
  }
  return true;
}

/** Does a solid mass cover this sample? The fills are flat in z, so the
 *  depth test is one comparison — a mass NEARER the viewer than the
 *  sample, whose silhouette contains it. */
function inkHidden(fills: readonly InkFill[], p: InkPoint): boolean {
  for (const f of fills) {
    if (f.points.length < 3) continue;
    if (f.points[0].z <= p.z) continue;
    if (pointInConvex(f.points, p.x, p.y)) return true;
  }
  return false;
}

/** One run of samples → the closed outline of its ribbon: the left edge
 *  forward, the right edge back. */
function ribbonPoly(id: string, pts: readonly InkPoint[]): InkPoly {
  const left: Array<{ x: number; y: number }> = [];
  const right: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < pts.length; i++) {
    const [a, b] = ribbonEdges(pts, i);
    left.push(a);
    right.push(b);
  }
  right.reverse();
  return { id, points: [...left, ...right] };
}

/**
 * The figure's ink as fillable polygons — the sketch drawn without a
 * canvas. Same pen, same masses, same view as {@link buildInkDraw}; the
 * body solids become occlusion rather than depth writes, so what a bake
 * shows and what the stage shows are the same figure.
 *
 * Everything is one ink colour: the caller fills every polygon alike
 * (nonzero rule — a ribbon may cross itself at a tight curve).
 */
export function inkVector(
  pose: FiggiePose,
  turn: TurnLike,
  world: WorldJoints = solveWorld(pose),
): InkPoly[] {
  const strokes = sketchInk(pose, turn, world);
  const fills = sketchFills(pose, turn, world);
  const out: InkPoly[] = [];
  for (const s of strokes) {
    const pts = s.points;
    let run: InkPoint[] = [];
    const flush = () => {
      if (run.length >= 2) out.push(ribbonPoly(s.id, run));
      run = [];
    };
    for (const p of pts) {
      if (inkHidden(fills, p)) flush();
      else run.push(p);
    }
    flush();
  }
  return out;
}
