// Figgie's one camera: orthographic, straight-on, with a single YAW about
// the figure's up axis — the only view control the rig offers. Yaw is a
// VIEW transform: the pose underneath never changes as the figure turns.
// Drags are DEFINED in this view's plane (pose.ts rotates bones about its
// normal), so the interaction needs no un-projection at all — the finger's
// view coordinates are the coordinates the pose math wants.

import { RIG_HEIGHT } from './skeleton';

/** The rig-space rect the camera frames: the T-pose plus breathing room
 *  (arms span ±41, feet reach z≈10 which yaw can swing into x). */
export const STAGE = { minX: -56, maxX: 56, minY: -6, maxY: RIG_HEIGHT + 6 };

/**
 * Rotate a rig-space point about the vertical axis through `pivotX` (the
 * figure's root, so a translated figure turns about itself) and drop it to
 * the view plane. `px` is the on-screen x, `pz` the depth (positive =
 * toward the viewer) — the painter's order and the depth buffer both key
 * off it.
 */
export function projectYaw(
  x: number, y: number, z: number, yaw: number, pivotX: number,
): { px: number; py: number; pz: number } {
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  const dx = x - pivotX;
  return { px: pivotX + dx * cos + z * sin, py: y, pz: -dx * sin + z * cos };
}

/** How rig space maps onto a CSS-pixel canvas: uniform scale, centered,
 *  the whole STAGE contained. */
export interface Fit {
  scale: number;
  toScreenX(px: number): number;
  toScreenY(py: number): number;
  toViewX(screenX: number): number;
  toViewY(screenY: number): number;
}

export function fitStage(widthPx: number, heightPx: number): Fit {
  const stageW = STAGE.maxX - STAGE.minX;
  const stageH = STAGE.maxY - STAGE.minY;
  const scale = Math.min(widthPx / stageW, heightPx / stageH) || 1;
  const cx = (STAGE.minX + STAGE.maxX) / 2;
  const cy = (STAGE.minY + STAGE.maxY) / 2;
  return {
    scale,
    toScreenX: (px) => widthPx / 2 + (px - cx) * scale,
    toScreenY: (py) => heightPx / 2 - (py - cy) * scale, // y flips: rig is y-up
    toViewX: (sx) => cx + (sx - widthPx / 2) / scale,
    toViewY: (sy) => cy - (sy - heightPx / 2) / scale,
  };
}
