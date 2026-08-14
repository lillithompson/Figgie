// The posed figure as PRIMITIVES — capsules, ellipsoids, grab knobs — in
// rig-world space. This is the one place flesh meets bones: the WebGL
// renderer draws exactly this list, and `projectSilhouette` flattens the
// same list into depth-sorted 2D shapes for hosts that want to bake the
// figure into their own scene (vector export, thumbnails). Renderer and
// bake can never disagree about what the figure looks like, because they
// read the same geometry.

import { BODY_BLOBS, BODY_CAPSULES, DRAG_TARGETS, JointId, knobRadius } from './skeleton';
import { FiggiePose, WorldJoints, solveWorld } from './pose';
import { Quat, quatMul, quatRotate, quatToMat3 } from './quat';
import { TurnLike, projectTurn, turnQuat } from './view';

export interface WorldCapsule {
  kind: 'capsule';
  ax: number; ay: number; az: number;
  bx: number; by: number; bz: number;
  radius: number;
}

export interface WorldBlob {
  kind: 'blob';
  cx: number; cy: number; cz: number;
  rx: number; ry: number; rz: number;
  /** The ellipsoid's orientation — the joint's full posed rotation, so
   *  hands, feet and the face swing with their limb in 3D. */
  rot: Quat;
  tint?: 'eye';
}

export interface WorldKnob {
  kind: 'knob';
  joint: JointId;
  cx: number; cy: number; cz: number;
  radius: number;
}

export type WorldPrimitive = WorldCapsule | WorldBlob | WorldKnob;

/** Everything the figure is made of, posed, in rig-world space. Knobs are
 *  the drag-target affordances, drawn a shade darker like the joint bands
 *  on a wooden mannequin. */
export function posePrimitives(
  pose: FiggiePose,
  world: WorldJoints = solveWorld(pose),
): WorldPrimitive[] {
  const out: WorldPrimitive[] = [];
  for (const c of BODY_CAPSULES) {
    const a = world[c.a];
    const b = world[c.b];
    out.push({
      kind: 'capsule',
      ax: a.x, ay: a.y, az: a.z, bx: b.x, by: b.y, bz: b.z,
      radius: c.radius,
    });
  }
  for (const blob of BODY_BLOBS) {
    const j = world[blob.joint];
    // The whole offset rides the joint's 3D rotation: nod the head and the
    // eyes pitch with it, swing a leg and the foot block follows.
    const [ox, oy, oz] = quatRotate(j.rot, blob.ox, blob.oy, blob.oz);
    out.push({
      kind: 'blob',
      cx: j.x + ox,
      cy: j.y + oy,
      cz: j.z + oz,
      rx: blob.rx, ry: blob.ry, rz: blob.rz,
      rot: j.rot,
      ...(blob.tint ? { tint: blob.tint } : {}),
    });
  }
  for (const t of DRAG_TARGETS) {
    // Fine targets (fingertips, the ball of the foot) draw no knob: five
    // wooden beads per hand would clutter every view for joints only
    // grabbable zoomed in, and a ball bead would sit inside the ankle's —
    // the finger and the foot themselves are the affordance there.
    if (t.fine) continue;
    const j = world[t.joint];
    out.push({ kind: 'knob', joint: t.joint, cx: j.x, cy: j.y, cz: j.z, radius: knobRadius(t.joint) });
  }
  return out;
}

// ── Projected silhouette (for host-side baking) ─────────────────────

export interface FlatCapsule {
  kind: 'capsule';
  ax: number; ay: number; bx: number; by: number;
  radius: number;
  depth: number;
}

export interface FlatEllipse {
  kind: 'ellipse';
  cx: number; cy: number;
  /** Semi-axes of the projected outline. */
  rx: number; ry: number;
  /** CCW rotation (radians) of the rx axis from +x. */
  rot: number;
  depth: number;
  tint?: 'eye';
}

export type FlatPrimitive = FlatCapsule | FlatEllipse;

/**
 * The figure under `turn`, flattened to 2D outlines in rig units, sorted
 * back → front (painter's order — an eye on the far side of the head lands
 * behind it and disappears, exactly as the depth buffer hides it in GL).
 * Knobs are affordance, not figure, and are left out.
 *
 * An orthographic projection maps a sphere to a circle of the same radius
 * and an ellipsoid to an ellipse; the ellipse of a turned ellipsoid comes
 * from the 2×2 eigenproblem of A·Aᵀ (A = the projected axis matrix), which
 * is exact — not a bounding approximation.
 */
export function projectSilhouette(pose: FiggiePose, turn: TurnLike): FlatPrimitive[] {
  const world = solveWorld(pose);
  const q = turnQuat(turn);
  const pivotX = world.root.x;
  const pivotY = world.root.y;
  const out: FlatPrimitive[] = [];
  for (const p of posePrimitives(pose, world)) {
    if (p.kind === 'capsule') {
      const a = projectTurn(p.ax, p.ay, p.az, q, pivotX, pivotY);
      const b = projectTurn(p.bx, p.by, p.bz, q, pivotX, pivotY);
      out.push({
        kind: 'capsule',
        ax: a.px, ay: a.py, bx: b.px, by: b.py,
        radius: p.radius,
        depth: (a.pz + b.pz) / 2,
      });
    } else if (p.kind === 'blob') {
      const c = projectTurn(p.cx, p.cy, p.cz, q, pivotX, pivotY);
      out.push({ ...projectedEllipse(p, q), cx: c.px, cy: c.py, depth: c.pz, ...(p.tint ? { tint: p.tint } : {}) });
    }
  }
  out.sort((a, b) => a.depth - b.depth);
  return out;
}

/** Exact outline of an ellipsoid (axes scaled by rx/ry/rz, oriented by the
 *  joint's 3D rotation, then turned by the view quat and orthographically
 *  projected). */
function projectedEllipse(
  blob: WorldBlob, q: Quat,
): { kind: 'ellipse'; rx: number; ry: number; rot: number } {
  // A = P · V · R · S, a 2×3: rows 1–2 of the composed rotation, columns
  // scaled by the semi-axes — the screen image of each ellipsoid axis.
  const m = quatToMat3(quatMul(q, blob.rot)); // column-major
  const a11 = m[0] * blob.rx;
  const a12 = m[3] * blob.ry;
  const a13 = m[6] * blob.rz;
  const a21 = m[1] * blob.rx;
  const a22 = m[4] * blob.ry;
  const a23 = m[7] * blob.rz;
  // Outline = image of the unit sphere under A: semi-axes are the singular
  // values of A — the eigenvalues of the 2×2 M = A·Aᵀ.
  const m11 = a11 * a11 + a12 * a12 + a13 * a13;
  const m12 = a11 * a21 + a12 * a22 + a13 * a23;
  const m22 = a21 * a21 + a22 * a22 + a23 * a23;
  const tr = m11 + m22;
  const det = m11 * m22 - m12 * m12;
  const disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
  const l1 = tr / 2 + disc;
  const l2 = Math.max(0, tr / 2 - disc);
  const rot = Math.abs(m12) < 1e-9 && m11 >= m22 ? 0 : Math.atan2(l1 - m11, m12 === 0 ? 1e-12 : m12);
  return { kind: 'ellipse', rx: Math.sqrt(l1), ry: Math.sqrt(l2), rot };
}
