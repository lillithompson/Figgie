// Minimal quaternion kit for the pose model. Quats are [x, y, z, w],
// unit-length by convention; every producer normalizes. Pure and tiny —
// only what bones need: compose, invert, rotate a vector, build from an
// axis-angle, and turn into a 3×3 for the renderer.

export type Quat = [number, number, number, number];

export const QUAT_IDENTITY: Quat = [0, 0, 0, 1];

export function quatFromAxisAngle(
  ax: number, ay: number, az: number, angle: number,
): Quat {
  const len = Math.hypot(ax, ay, az);
  if (len < 1e-12) return [0, 0, 0, 1];
  const s = Math.sin(angle / 2) / len;
  return [ax * s, ay * s, az * s, Math.cos(angle / 2)];
}

/** a ∘ b — apply b first, then a. */
export function quatMul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/** Inverse of a unit quat (its conjugate). */
export function quatInv(q: Quat): Quat {
  return [-q[0], -q[1], -q[2], q[3]];
}

export function quatNormalize(q: Quat): Quat {
  const len = Math.hypot(q[0], q[1], q[2], q[3]);
  if (!(len > 1e-12)) return [0, 0, 0, 1];
  // Canonical sign (w ≥ 0): q and −q are the same rotation, and one
  // representative keeps serialized poses comparable.
  const s = (q[3] < 0 ? -1 : 1) / len;
  return [q[0] * s, q[1] * s, q[2] * s, q[3] * s];
}

/** Rotate vector (x, y, z) by unit quat q. */
export function quatRotate(
  q: Quat, x: number, y: number, z: number,
): [number, number, number] {
  // t = 2 q_v × v; v' = v + w t + q_v × t
  const [qx, qy, qz, qw] = q;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  return [
    x + qw * tx + qy * tz - qz * ty,
    y + qw * ty + qz * tx - qx * tz,
    z + qw * tz + qx * ty - qy * tx,
  ];
}

/** Column-major 3×3 rotation matrix of a unit quat. */
export function quatToMat3(q: Quat): [
  number, number, number, number, number, number, number, number, number,
] {
  const [x, y, z, w] = q;
  const xx = x * x, yy = y * y, zz = z * z;
  const xy = x * y, xz = x * z, yz = y * z;
  const wx = w * x, wy = w * y, wz = w * z;
  return [
    1 - 2 * (yy + zz), 2 * (xy + wz), 2 * (xz - wy),
    2 * (xy - wz), 1 - 2 * (xx + zz), 2 * (yz + wx),
    2 * (xz + wy), 2 * (yz - wx), 1 - 2 * (xx + yy),
  ];
}

/** Whether q is (numerically) no rotation at all. */
export function quatIsIdentity(q: Quat, eps = 1e-9): boolean {
  return Math.abs(q[3]) >= 1 - eps;
}

/** Whether two unit quats are the same rotation within `eps` (compares the
 *  angle between them, sign-insensitively). */
export function quatEquals(a: Quat, b: Quat, eps = 1e-3): boolean {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  return Math.abs(dot) >= 1 - eps;
}
