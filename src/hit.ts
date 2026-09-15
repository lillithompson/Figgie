// Which drag target a press lands on: every target's joint projected to
// the canvas under the current turn + fit, nearest one within the touch
// radius wins. Pure, so the grab rules are node-testable.

import { DRAG_TARGETS, DragTarget, JointId, grabRadius, restJoint } from './skeleton';
import { FiggiePose, solveWorld } from './pose';
import { Fit, TurnLike, projectTurn, turnQuat } from './view';

/** Touch capture radius in CSS px — a thumb, not a cursor. */
export const HIT_RADIUS_PX = 28;

export interface Hit {
  target: DragTarget;
  /** Finger − joint at grab time, in VIEW coordinates (the turned frame
   *  drags are resolved in), so a drag moves the joint by the finger's
   *  DELTA rather than snapping it under the tip. */
  grabDx: number;
  grabDy: number;
  distancePx: number;
}

/**
 * Hit-test a canvas-space point (CSS px). Nearest target within its own
 * capture radius ({@link grabRadius}: a thumb for an ordinary joint, half
 * its drawn bone for a FINE one — a finger segment, the heel); null clears
 * the way for the host's own gestures. So a loose press near a hand still
 * grabs the wrist, while a press ON a drawn finger grabs that finger,
 * at any size.
 */
export function hitTest(
  pose: FiggiePose,
  turn: TurnLike,
  fit: Fit,
  screenX: number,
  screenY: number,
): Hit | null {
  const world = solveWorld(pose);
  const q = turnQuat(turn);
  const pivotX = world.root.x;
  const pivotY = world.root.y;
  const viewX = fit.toViewX(screenX);
  const viewY = fit.toViewY(screenY);
  /** One joint on screen, CSS px. */
  const at = (id: JointId) => {
    const j = world[id];
    const p = projectTurn(j.x, j.y, j.z, q, pivotX, pivotY);
    return { x: fit.toScreenX(p.px), y: fit.toScreenY(p.py), px: p.px, py: p.py };
  };
  let best: Hit | null = null;
  for (const target of DRAG_TARGETS) {
    const p = at(target.joint);
    const dx = p.x - screenX;
    const dy = p.y - screenY;
    const d = Math.hypot(dx, dy);
    if (d > grabRadius(target, boneSpan(target, at), HIT_RADIUS_PX)) continue;
    if (!best || d < best.distancePx) {
      best = {
        target,
        grabDx: viewX - p.px,
        grabDy: viewY - p.py,
        distancePx: d,
      };
    }
  }
  return best;
}

/** The target's own bone as DRAWN — joint to parent, in the caller's
 *  units — which is what {@link grabRadius} measures a fine target's
 *  capture radius against. Computed only for the targets that need it. */
export function boneSpan<T extends { x: number; y: number }>(
  target: DragTarget,
  at: (id: JointId) => T,
): number {
  if (!target.fine) return 0;
  const parent = restJoint(target.joint).parent;
  if (!parent) return 0;
  const a = at(target.joint);
  const b = at(parent);
  return Math.hypot(a.x - b.x, a.y - b.y);
}
