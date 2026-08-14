// Which drag target a press lands on: every target's joint projected to
// the canvas under the current turn + fit, nearest one within the touch
// radius wins. Pure, so the grab rules are node-testable.

import { DRAG_TARGETS, DragTarget } from './skeleton';
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
 * Hit-test a canvas-space point (CSS px). Nearest target within
 * {@link HIT_RADIUS_PX}; null clears the way for the host's own gestures.
 * FINE targets (fingertips) are offered only with `fine` — the caller's
 * "the hand is big enough on screen" zoom gate — so at ordinary sizes a
 * press near a hand still grabs the wrist.
 */
export function hitTest(
  pose: FiggiePose,
  turn: TurnLike,
  fit: Fit,
  screenX: number,
  screenY: number,
  fine = false,
): Hit | null {
  const world = solveWorld(pose);
  const q = turnQuat(turn);
  const pivotX = world.root.x;
  const pivotY = world.root.y;
  const viewX = fit.toViewX(screenX);
  const viewY = fit.toViewY(screenY);
  let best: Hit | null = null;
  for (const target of DRAG_TARGETS) {
    if (target.fine && !fine) continue;
    const j = world[target.joint];
    const p = projectTurn(j.x, j.y, j.z, q, pivotX, pivotY);
    const dx = fit.toScreenX(p.px) - screenX;
    const dy = fit.toScreenY(p.py) - screenY;
    const d = Math.hypot(dx, dy);
    if (d > HIT_RADIUS_PX) continue;
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
