// The two meshes the classic figure is drawn with: a unit sphere (joints,
// head, ellipsoids via non-uniform scale) and a unit cylinder (bone
// shafts). The ink (NPR) shader uses none of these — its geometry is 2D
// ribbons built per frame (see ink.ts). Generated once at startup; pure
// functions so the counts and shapes are node-testable.

export interface Mesh {
  /** Interleaved x,y,z position + x,y,z normal per vertex. */
  data: Float32Array;
  indices: Uint16Array;
}

/** Lat/long unit sphere. `stacks` ≥ 2, `slices` ≥ 3. */
export function unitSphere(stacks = 12, slices = 16): Mesh {
  const verts: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= stacks; i++) {
    const phi = (i / stacks) * Math.PI; // 0 = north pole
    const y = Math.cos(phi);
    const r = Math.sin(phi);
    for (let j = 0; j <= slices; j++) {
      const theta = (j / slices) * Math.PI * 2;
      const x = r * Math.cos(theta);
      const z = r * Math.sin(theta);
      verts.push(x, y, z, x, y, z); // unit sphere: normal == position
    }
  }
  const row = slices + 1;
  for (let i = 0; i < stacks; i++) {
    for (let j = 0; j < slices; j++) {
      const a = i * row + j;
      idx.push(a, a + row, a + 1, a + 1, a + row, a + row + 1);
    }
  }
  return { data: new Float32Array(verts), indices: new Uint16Array(idx) };
}

/** Open unit cylinder along +y from y=0 to y=1, radius 1. Ends are left
 *  open — every shaft gets a sphere at each end anyway (that is what makes
 *  a scaled cylinder read as a capsule). */
export function unitCylinder(slices = 14): Mesh {
  const verts: number[] = [];
  const idx: number[] = [];
  for (let cap = 0; cap <= 1; cap++) {
    for (let j = 0; j <= slices; j++) {
      const theta = (j / slices) * Math.PI * 2;
      const x = Math.cos(theta);
      const z = Math.sin(theta);
      verts.push(x, cap, z, x, 0, z);
    }
  }
  const row = slices + 1;
  for (let j = 0; j < slices; j++) {
    idx.push(j, row + j, j + 1, j + 1, row + j, row + j + 1);
  }
  return { data: new Float32Array(verts), indices: new Uint16Array(idx) };
}

