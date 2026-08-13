/** The two generated meshes: well-formed, unit-sized, unit normals. */

import { unitCylinder, unitSphere } from '../mesh';

describe('unitSphere', () => {
  const m = unitSphere();

  it('is indexed, in range, interleaved pos+normal', () => {
    expect(m.data.length % 6).toBe(0);
    const vertCount = m.data.length / 6;
    for (const i of m.indices) expect(i).toBeLessThan(vertCount);
    expect(m.indices.length % 3).toBe(0);
  });

  it('every vertex sits on the unit sphere with its own normal', () => {
    for (let v = 0; v < m.data.length; v += 6) {
      const r = Math.hypot(m.data[v], m.data[v + 1], m.data[v + 2]);
      expect(r).toBeCloseTo(1, 5);
      expect(m.data[v + 3]).toBeCloseTo(m.data[v], 6);
      expect(m.data[v + 4]).toBeCloseTo(m.data[v + 1], 6);
      expect(m.data[v + 5]).toBeCloseTo(m.data[v + 2], 6);
    }
  });
});

describe('unitCylinder', () => {
  const m = unitCylinder();

  it('spans y 0..1 at radius 1 with radial normals', () => {
    for (let v = 0; v < m.data.length; v += 6) {
      expect(Math.hypot(m.data[v], m.data[v + 2])).toBeCloseTo(1, 5);
      expect(m.data[v + 1] === 0 || m.data[v + 1] === 1).toBe(true);
      expect(m.data[v + 4]).toBe(0); // normal has no y — open shaft
      expect(Math.hypot(m.data[v + 3], m.data[v + 5])).toBeCloseTo(1, 5);
    }
  });

  it('is small enough to be free: whole figure well under 2k triangles', () => {
    const sphereTris = unitSphere().indices.length / 3;
    const cylTris = m.indices.length / 3;
    // ~40 draws per frame at these counts is nothing for a mobile GPU.
    expect(sphereTris).toBeLessThan(500);
    expect(cylTris).toBeLessThan(100);
  });
});
