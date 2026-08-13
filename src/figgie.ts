// The Figgie component: hand it a <canvas>, get back a poseable mannequin.
//
// Fully encapsulated — it owns the WebGL context, the pointer gestures and
// the render scheduling; the host owns nothing but the canvas element and
// the pose/yaw state it chooses to keep. Everything the component decides
// (which joint a press grabs, what a drag does to the hierarchy, what the
// figure looks like) lives in the pure modules beside this file, so this
// one is only wiring: events in, frames out.
//
// Frames are drawn ON DEMAND — a dirty flag and one requestAnimationFrame
// per change — so an idle rig costs nothing, and an active drag costs one
// small frame per pointer move. That is the whole 90 fps story: there is
// no loop to fall behind.

import { FiggiePose, defaultPose, poseEquals, resolveDrag, sanitizePose, solveWorld } from './pose';
import { JointId } from './skeleton';
import { Hit, hitTest } from './hit';
import { posePrimitives } from './primitives';
import { DEFAULT_COLORS, RigColors, Renderer, createRenderer } from './render';
import { Fit, TurnLike, fitStage, turnQuat } from './view';

export interface FiggieOptions {
  /** Starting pose; anything JSON-shaped is sanitized. Default: T-pose. */
  initialPose?: unknown;
  /** Starting turn: yaw radians about the up axis, or a full `Turn` about
   *  any rig-plane axis. Default 0 (facing front). */
  initialYaw?: TurnLike;
  /** Fired on every pose change: live per pointer-move during a drag, and
   *  once more with `live: false` when the finger lifts (the commit). */
  onPoseChange?(pose: FiggiePose, meta: { live: boolean }): void;
  colors?: Partial<RigColors>;
  /** false = the component is a pure RENDERER: it attaches no pointer
   *  listeners and never re-poses itself. For hosts that embed the rig in
   *  their own scene and arbitrate gestures themselves — they drive it
   *  through setPose / setYaw / setActiveJoint, usually built on the same
   *  exported pure functions (hitTest, resolveDrag) this component uses.
   *  Default true (the self-contained drag-to-pose canvas). */
  interactive?: boolean;
}

export interface FiggieHandle {
  getPose(): FiggiePose;
  setPose(pose: unknown): void;
  getYaw(): TurnLike;
  setYaw(yaw: TurnLike): void;
  /** Back to the T-pose (turn untouched — the slider owns it). */
  reset(): void;
  /** Light one joint's knob in the accent colour (a host-driven grab);
   *  null clears it. The component's own drags manage this themselves. */
  setActiveJoint(joint: JointId | null): void;
  /** True once the figure differs from the T-pose. */
  isPosed(): boolean;
  /** Re-read the canvas size (called automatically via ResizeObserver
   *  where available). */
  resize(): void;
  destroy(): void;
}

export function createFiggie(canvas: HTMLCanvasElement, opts: FiggieOptions = {}): FiggieHandle {
  const gl = canvas.getContext('webgl', {
    alpha: true,
    antialias: true,
    depth: true,
    premultipliedAlpha: true,
    preserveDrawingBuffer: false,
  });
  if (!gl) throw new Error('figgie: WebGL is unavailable on this canvas');

  const colors: RigColors = { ...DEFAULT_COLORS, ...opts.colors };
  const renderer: Renderer = createRenderer(gl);

  let pose = sanitizePose(opts.initialPose ?? defaultPose());
  let turn: TurnLike = opts.initialYaw ?? 0;
  let fit: Fit = fitStage(1, 1);
  let cssWidth = 1;
  let cssHeight = 1;
  let grab: Hit | null = null;
  let destroyed = false;

  // ── Render scheduling: one rAF per change, none while idle ─────────
  let framePending = false;
  const requestRender = () => {
    if (framePending || destroyed) return;
    framePending = true;
    requestAnimationFrame(() => {
      framePending = false;
      if (destroyed) return;
      const root = solveWorld(pose).root;
      renderer.draw({
        primitives: posePrimitives(pose),
        turn: turnQuat(turn),
        pivotX: root.x,
        pivotY: root.y,
        fit,
        cssWidth,
        cssHeight,
        activeJoint: grab?.target.joint ?? hostActive,
        colors,
      });
    });
  };

  const resize = () => {
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    cssWidth = canvas.clientWidth || canvas.width;
    cssHeight = canvas.clientHeight || canvas.height;
    const w = Math.max(1, Math.round(cssWidth * dpr));
    const h = Math.max(1, Math.round(cssHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    fit = fitStage(cssWidth, cssHeight);
    requestRender();
  };

  // ── Pointer gestures ───────────────────────────────────────────────
  // The drag math lives IN view coordinates (every rotation is about the
  // view normal), so the finger's screen point converts through the fit
  // and nothing else.
  const viewPointAt = (e: PointerEvent): { x: number; y: number } => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: fit.toViewX(e.clientX - rect.left),
      y: fit.toViewY(e.clientY - rect.top),
    };
  };

  const onPointerDown = (e: PointerEvent) => {
    if (!e.isPrimary) return;
    const rect = canvas.getBoundingClientRect();
    const hit = hitTest(pose, turn, fit, e.clientX - rect.left, e.clientY - rect.top);
    if (!hit) return;
    grab = hit;
    canvas.setPointerCapture?.(e.pointerId);
    e.preventDefault();
    requestRender();
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!grab || !e.isPrimary) return;
    const p = viewPointAt(e);
    pose = resolveDrag(pose, grab.target, p.x - grab.grabDx, p.y - grab.grabDy, turn);
    opts.onPoseChange?.(pose, { live: true });
    requestRender();
    e.preventDefault();
  };

  const endDrag = (commit: boolean) => {
    if (!grab) return;
    grab = null;
    if (commit) opts.onPoseChange?.(pose, { live: false });
    requestRender();
  };
  const onPointerUp = (e: PointerEvent) => { if (e.isPrimary) endDrag(true); };
  const onPointerCancel = () => endDrag(true);

  // Host-driven highlight (setActiveJoint) — the component's own grabs
  // take precedence while they live.
  let hostActive: JointId | null = null;

  const interactive = opts.interactive !== false;
  if (interactive) {
    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerCancel);
  }

  const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
  observer?.observe(canvas);
  resize();

  return {
    getPose: () => pose,
    setPose(next: unknown) {
      pose = sanitizePose(next);
      requestRender();
    },
    getYaw: () => turn,
    setYaw(next: TurnLike) {
      // Kept as given; turnQuat sanitizes non-finite parts at every use.
      turn = typeof next === 'number' && !Number.isFinite(next) ? 0 : next;
      requestRender();
    },
    reset() {
      pose = defaultPose();
      opts.onPoseChange?.(pose, { live: false });
      requestRender();
    },
    isPosed: () => !poseEquals(pose, defaultPose()),
    setActiveJoint(joint: JointId | null) {
      hostActive = joint;
      requestRender();
    },
    resize,
    destroy() {
      destroyed = true;
      observer?.disconnect();
      if (interactive) {
        canvas.removeEventListener('pointerdown', onPointerDown);
        canvas.removeEventListener('pointermove', onPointerMove);
        canvas.removeEventListener('pointerup', onPointerUp);
        canvas.removeEventListener('pointercancel', onPointerCancel);
      }
      renderer.dispose();
    },
  };
}
