// Figgie's WebGL1 renderer: the ink sketch, and nothing else.
//
// The whole hand-drawn figure arrives as ONE pre-triangulated 2D ribbon
// batch (ink.ts builds it in view space, taper and wobble included) and
// draws flat-colored in a single call through a tiny 2D program — a line
// drawing, not a 3D shape, so no lighting. Depth is kept only so the
// opaque body masses can hide the strokes that pass genuinely behind
// them.
//
// Frames are drawn on demand only (the component schedules them; there
// is no free-running loop).

import { InkBatch, InkDraw } from './ink';
import { Fit } from './view';

export interface RigColors {
  /** The grab marker: the active joint's accent ring. */
  knobActive: [number, number, number];
  /** The ink sketch's line colour. */
  ink: [number, number, number];
  /** The opaque ground the sketch's solid masses (chest, pelvis, palms,
   *  feet, head, joint circles) fill with — the paper the figure is drawn
   *  on. A drawn solid is not see-through: whatever the host page has
   *  behind a mass is hidden by it. Hosts pass their page colour. */
  paper: [number, number, number];
}

/** A sky-blue accent, a soft charcoal for the ink, and plain white paper. */
export const DEFAULT_COLORS: RigColors = {
  knobActive: [0.22, 0.74, 0.97],
  ink: [0.16, 0.15, 0.14],
  paper: [1, 1, 1],
};

export interface DrawInput {
  /** The ink sketch for this frame (ink.buildInkDraw) — it IS the frame. */
  ink: InkDraw;
  fit: Fit;
  cssWidth: number;
  cssHeight: number;
  colors: RigColors;
}

// The ink program: view-space positions through the fit's ortho, one flat
// colour. The ribbons carry all their shape (taper, wobble) in the
// geometry; z rides along so strokes depth-test against the solid body
// masses.
const VS_INK = `
attribute vec3 aPos;
uniform vec4 uView; // kx, ky, centerX, centerY (view units -> NDC)
void main() {
  gl_Position = vec4((aPos.x - uView.z) * uView.x, (aPos.y - uView.w) * uView.y, -aPos.z / 150.0, 1.0);
}`;

const FS_INK = `
precision mediump float;
uniform vec3 uInk;
void main() {
  gl_FragColor = vec4(uInk, 1.0);
}`;

export interface Renderer {
  draw(input: DrawInput): void;
  dispose(): void;
}

export function createRenderer(gl: WebGLRenderingContext): Renderer {
  const inkProgram = buildProgram(gl, VS_INK, FS_INK);
  const aInkPos = gl.getAttribLocation(inkProgram, 'aPos');
  const uInkView = gl.getUniformLocation(inkProgram, 'uView');
  const uInkColor = gl.getUniformLocation(inkProgram, 'uInk');
  // One dynamic buffer pair, re-filled per ink frame (a whole figure is
  // ~2 KB of ribbon — nothing worth caching between poses).
  const inkVbo = gl.createBuffer()!;
  const inkIbo = gl.createBuffer()!;

  gl.enable(gl.DEPTH_TEST);
  gl.clearColor(0, 0, 0, 0);

  return {
    draw(input: DrawInput) {
      const { colors, fit, cssWidth, cssHeight } = input;
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

      // Flat ribbons over solid paper body masses. The masses paint opaque
      // in the paper colour AND write depth, so they hide both what the
      // page has behind the figure and the figure's own strokes passing
      // genuinely behind the chest, pelvis or head (those fail the depth
      // test and vanish), while lines merely CROSSING (same depth) draw
      // freely, construction-style.
      gl.useProgram(inkProgram);
      gl.enableVertexAttribArray(aInkPos);
      gl.uniform4f(
        uInkView,
        (2 * fit.scale) / cssWidth,
        (2 * fit.scale) / cssHeight,
        fit.toViewX(cssWidth / 2),
        fit.toViewY(cssHeight / 2),
      );
      const drawBatch = (batch: InkBatch, color: [number, number, number]) => {
        if (batch.indices.length === 0) return;
        gl.bindBuffer(gl.ARRAY_BUFFER, inkVbo);
        gl.bufferData(gl.ARRAY_BUFFER, batch.positions, gl.DYNAMIC_DRAW);
        gl.vertexAttribPointer(aInkPos, 3, gl.FLOAT, false, 12, 0);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, inkIbo);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, batch.indices, gl.DYNAMIC_DRAW);
        gl.uniform3fv(uInkColor, color);
        gl.drawElements(gl.TRIANGLES, batch.indices.length, gl.UNSIGNED_SHORT, 0);
      };
      drawBatch(input.ink.fills, colors.paper);
      drawBatch(input.ink.main, colors.ink);
      if (input.ink.accent) {
        // The grab marker always shows — feedback beats occlusion.
        gl.disable(gl.DEPTH_TEST);
        drawBatch(input.ink.accent, colors.knobActive);
        gl.enable(gl.DEPTH_TEST);
      }
    },
    dispose() {
      gl.deleteBuffer(inkVbo);
      gl.deleteBuffer(inkIbo);
      gl.deleteProgram(inkProgram);
    },
  };
}

function buildProgram(gl: WebGLRenderingContext, vs: string, fs: string): WebGLProgram {
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
  gl.attachShader(program, compile(gl.VERTEX_SHADER, vs));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`figgie program: ${gl.getProgramInfoLog(program) ?? 'link failed'}`);
  }
  return program;
}
