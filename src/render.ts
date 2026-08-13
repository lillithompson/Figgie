// Figgie's WebGL1 renderer. Deliberately small: two static meshes (sphere,
// cylinder), one lambert program, and one draw call per primitive — the
// whole figure is ~40 draws of tiny geometry, far inside a mobile WebView's
// 90 fps budget, and it only draws when something changed (the component
// schedules frames on demand; there is no free-running loop).
//
// Every model transform on the figure is T · R · S with an arbitrary 3×3
// rotation — bones and blobs orient freely in 3D now that poses rotate
// about the view axis — composed straight into scratch matrices by one
// builder.

import { Mesh, unitCylinder, unitSphere } from './mesh';
import { WorldPrimitive } from './primitives';
import { Quat, quatFromAxisAngle, quatToMat3 } from './quat';
import { Fit } from './view';

export interface RigColors {
  body: [number, number, number];
  knob: [number, number, number];
  knobActive: [number, number, number];
  eye: [number, number, number];
}

/** Stewie's warm wood tan, darker joint bands, near-black eye dots. */
export const DEFAULT_COLORS: RigColors = {
  body: [0.87, 0.7, 0.48],
  knob: [0.58, 0.43, 0.27],
  knobActive: [0.22, 0.74, 0.97],
  eye: [0.14, 0.11, 0.09],
};

export interface DrawInput {
  primitives: readonly WorldPrimitive[];
  /** The view rotation (turnQuat of the host's turn). */
  turn: Quat;
  /** The point the turn pivots about (the figure's root). */
  pivotX: number;
  pivotY: number;
  fit: Fit;
  cssWidth: number;
  cssHeight: number;
  /** Joint whose knob lights in the accent colour (a live grab). */
  activeJoint: string | null;
  colors: RigColors;
}

const VS = `
attribute vec3 aPos;
attribute vec3 aNormal;
uniform mat4 uMVP;
uniform mat3 uNormal;
varying vec3 vN;
void main() {
  gl_Position = uMVP * vec4(aPos, 1.0);
  vN = uNormal * aNormal;
}`;

const FS = `
precision mediump float;
varying vec3 vN;
uniform vec3 uColor;
void main() {
  vec3 n = normalize(vN);
  float l = 0.45 + 0.55 * max(dot(n, normalize(vec3(0.35, 0.55, 0.75))), 0.0);
  gl_FragColor = vec4(uColor * l, 1.0);
}`;

interface GlMesh {
  vbo: WebGLBuffer;
  ibo: WebGLBuffer;
  count: number;
}

export interface Renderer {
  draw(input: DrawInput): void;
  dispose(): void;
}

export function createRenderer(gl: WebGLRenderingContext): Renderer {
  const program = buildProgram(gl);
  const aPos = gl.getAttribLocation(program, 'aPos');
  const aNormal = gl.getAttribLocation(program, 'aNormal');
  const uMVP = gl.getUniformLocation(program, 'uMVP');
  const uNormal = gl.getUniformLocation(program, 'uNormal');
  const uColor = gl.getUniformLocation(program, 'uColor');

  const sphere = upload(gl, unitSphere());
  const cylinder = upload(gl, unitCylinder());

  gl.enable(gl.DEPTH_TEST);
  gl.clearColor(0, 0, 0, 0);

  // Scratch matrices — reused across every draw, zero per-frame allocation.
  const mvp = new Float32Array(16);
  const nrm = new Float32Array(9);
  /** The view rotation as a column-major 3×3 — set once per frame. */
  let view: readonly number[] = [1, 0, 0, 0, 1, 0, 0, 0, 1];

  let bound: GlMesh | null = null;
  const bind = (mesh: GlMesh) => {
    if (bound === mesh) return;
    bound = mesh;
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.vbo);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.ibo);
    gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 24, 0);
    gl.vertexAttribPointer(aNormal, 3, gl.FLOAT, false, 24, 12);
  };

  /** No rotation, for spheres. */
  const IDENTITY3: readonly number[] = [1, 0, 0, 0, 1, 0, 0, 0, 1];

  /** One primitive: view(turn about the pivot) · T(c) · R · S, plus the
   *  matching normal transform, composed straight into the scratch mats.
   *  `r` is a column-major world-space 3×3 rotation. */
  const setTransforms = (
    input: DrawInput,
    cx: number, cy: number, cz: number,
    r: readonly number[],
    sx: number, sy: number, sz: number,
  ) => {
    const { fit, cssWidth, cssHeight, pivotX, pivotY } = input;
    // Model basis columns (R·S) taken through the view rotation, and the
    // primitive's origin turned about the pivot point.
    const v = view;
    const exx = (v[0] * r[0] + v[3] * r[1] + v[6] * r[2]) * sx;
    const exy = (v[1] * r[0] + v[4] * r[1] + v[7] * r[2]) * sx;
    const exz = (v[2] * r[0] + v[5] * r[1] + v[8] * r[2]) * sx;
    const eyx = (v[0] * r[3] + v[3] * r[4] + v[6] * r[5]) * sy;
    const eyy = (v[1] * r[3] + v[4] * r[4] + v[7] * r[5]) * sy;
    const eyz = (v[2] * r[3] + v[5] * r[4] + v[8] * r[5]) * sy;
    const ezx = (v[0] * r[6] + v[3] * r[7] + v[6] * r[8]) * sz;
    const ezy = (v[1] * r[6] + v[4] * r[7] + v[7] * r[8]) * sz;
    const ezz = (v[2] * r[6] + v[5] * r[7] + v[8] * r[8]) * sz;
    const dx = cx - pivotX;
    const dy = cy - pivotY;
    const ox = pivotX + v[0] * dx + v[3] * dy + v[6] * cz;
    const oy = pivotY + v[1] * dx + v[4] * dy + v[7] * cz;
    const oz = v[2] * dx + v[5] * dy + v[8] * cz;
    // Ortho: ndcX = (x - centerX)·2s/w, ndcY = (y - centerY)·2s/h,
    // ndcZ = -z/150 (nearer → smaller depth). Center from the fit.
    const kx = 2 * fit.scale / cssWidth;
    const ky = 2 * fit.scale / cssHeight;
    const kz = -1 / 150;
    const ccx = fit.toViewX(cssWidth / 2);
    const ccy = fit.toViewY(cssHeight / 2);
    mvp.set([
      exx * kx, exy * ky, exz * kz, 0,
      eyx * kx, eyy * ky, eyz * kz, 0,
      ezx * kx, ezy * ky, ezz * kz, 0,
      (ox - ccx) * kx, (oy - ccy) * ky, oz * kz, 1,
    ]);
    // Normal matrix: view·R·S⁻¹ (inverse-transpose of rotation + scale) —
    // the same columns at inverse scale, normalized in the shader.
    const ix = 1 / sx, iy = 1 / sy, iz = 1 / sz;
    nrm.set([
      exx * ix * ix, exy * ix * ix, exz * ix * ix,
      eyx * iy * iy, eyy * iy * iy, eyz * iy * iy,
      ezx * iz * iz, ezy * iz * iz, ezz * iz * iz,
    ]);
    gl.uniformMatrix4fv(uMVP, false, mvp);
    gl.uniformMatrix3fv(uNormal, false, nrm);
  };

  /** Column-major rotation aligning the cylinder's +y onto the (unit)
   *  world direction (dx, dy, dz). */
  const alignY = (dx: number, dy: number, dz: number): readonly number[] => {
    // axis = ŷ × d = (dz, 0, -dx); angle = acos(d·ŷ).
    const axLen = Math.hypot(dz, dx);
    if (axLen < 1e-9) {
      // Parallel to ±y: identity, or a half-turn about x for downward.
      return dy >= 0 ? IDENTITY3 : [1, 0, 0, 0, -1, 0, 0, 0, -1];
    }
    return quatToMat3(quatFromAxisAngle(dz, 0, -dx, Math.acos(Math.max(-1, Math.min(1, dy)))));
  };

  const drawMesh = (mesh: GlMesh) => {
    bind(mesh);
    gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, 0);
  };

  return {
    draw(input: DrawInput) {
      const { colors } = input;
      view = quatToMat3(input.turn);
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.useProgram(program);
      gl.enableVertexAttribArray(aPos);
      gl.enableVertexAttribArray(aNormal);
      bound = null;

      for (const p of input.primitives) {
        if (p.kind === 'capsule') {
          gl.uniform3fv(uColor, colors.body);
          const dx = p.bx - p.ax;
          const dy = p.by - p.ay;
          const dz = p.bz - p.az;
          const len = Math.hypot(dx, dy, dz) || 1e-4;
          // Cylinder runs +y; rotate it onto the 3D bone direction.
          setTransforms(
            input, p.ax, p.ay, p.az,
            alignY(dx / len, dy / len, dz / len),
            p.radius, len, p.radius,
          );
          drawMesh(cylinder);
          // Sphere caps make the shaft a capsule.
          setTransforms(input, p.ax, p.ay, p.az, IDENTITY3, p.radius, p.radius, p.radius);
          drawMesh(sphere);
          setTransforms(input, p.bx, p.by, p.bz, IDENTITY3, p.radius, p.radius, p.radius);
          drawMesh(sphere);
        } else if (p.kind === 'blob') {
          gl.uniform3fv(uColor, p.tint === 'eye' ? colors.eye : colors.body);
          setTransforms(input, p.cx, p.cy, p.cz, quatToMat3(p.rot), p.rx, p.ry, p.rz);
          drawMesh(sphere);
        } else {
          gl.uniform3fv(uColor, p.joint === input.activeJoint ? colors.knobActive : colors.knob);
          setTransforms(input, p.cx, p.cy, p.cz, IDENTITY3, p.radius, p.radius, p.radius);
          drawMesh(sphere);
        }
      }
    },
    dispose() {
      gl.deleteBuffer(sphere.vbo);
      gl.deleteBuffer(sphere.ibo);
      gl.deleteBuffer(cylinder.vbo);
      gl.deleteBuffer(cylinder.ibo);
      gl.deleteProgram(program);
    },
  };
}

function upload(gl: WebGLRenderingContext, mesh: Mesh): GlMesh {
  const vbo = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, mesh.data, gl.STATIC_DRAW);
  const ibo = gl.createBuffer()!;
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
  return { vbo, ibo, count: mesh.indices.length };
}

function buildProgram(gl: WebGLRenderingContext): WebGLProgram {
  const compile = (type: number, src: string) => {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error(`figgie shader: ${gl.getShaderInfoLog(sh) ?? 'compile failed'}`);
    }
    return sh;
  };
  const program = gl.createProgram()!;
  gl.attachShader(program, compile(gl.VERTEX_SHADER, VS));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`figgie program: ${gl.getProgramInfoLog(program) ?? 'link failed'}`);
  }
  return program;
}
