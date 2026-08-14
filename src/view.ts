// Figgie's one camera: orthographic, straight-on, with a single TURN about
// an axis lying in the rig's plane — the only view control the rig offers.
// The turn is a VIEW transform: the pose underneath never changes as the
// figure turns. Drags are DEFINED in this view's plane (pose.ts rotates
// bones about its normal), so the interaction needs no un-projection at
// all — the finger's view coordinates are the coordinates the pose math
// wants.
//
// The classic turn is a yaw about the figure's own up axis (0, 1), and a
// plain number still means exactly that. A host that shows the rig through
// its own transform (mirrored, rotated in a scene) can instead pass a full
// `Turn` whose axis is whatever direction READS as "up" through that
// transform — pulled back into rig space — so its turn control always
// spins the figure about the axis the viewer sees as vertical.

import { Quat, quatFromAxisAngle, quatRotate } from './quat';
import { MAX_REACH, ROOT_REST_Y } from './skeleton';

/** A turn of `yaw` radians about the rig-plane axis (upX, upY, 0). The
 *  axis need not be unit length (it is normalized); a degenerate axis
 *  falls back to the figure's own up, (0, 1). */
export interface Turn {
  upX: number;
  upY: number;
  yaw: number;
}

/** Every API that takes a view turn accepts either the classic yaw scalar
 *  (about the up axis, (0, 1)) or a full `Turn`. */
export type TurnLike = number | Turn;

/** The view rotation of `turn` as a quat — precompute once per batch of
 *  {@link projectTurn} calls. Non-finite parts are treated as 0 (and a
 *  degenerate axis as the up axis), so a host's parsed JSON can never
 *  produce NaN geometry. */
export function turnQuat(turn: TurnLike): Quat {
  if (typeof turn === 'number') {
    return quatFromAxisAngle(0, 1, 0, Number.isFinite(turn) ? turn : 0);
  }
  const yaw = Number.isFinite(turn.yaw) ? turn.yaw : 0;
  const ux = Number.isFinite(turn.upX) ? turn.upX : 0;
  const uy = Number.isFinite(turn.upY) ? turn.upY : 0;
  if (!(Math.hypot(ux, uy) > 1e-9)) return quatFromAxisAngle(0, 1, 0, yaw);
  return quatFromAxisAngle(ux, uy, 0, yaw);
}

/** The rig-space rect the camera frames: everything the figure can ever
 *  reach, as a square about the rest root ({@link MAX_REACH}). Sized this
 *  way rather than snug around the T-pose because the stage is also the
 *  VIEWPORT the host gives the rig — a figure that reaches past it is a
 *  figure drawn clipped, and an arm raised straight up reaches well past
 *  a snug one. No pose can leave this box (bones only rotate about their
 *  parents) and no turn can either (the reach is measured in 3D, and
 *  rotating then projecting can only shorten a distance) — so long as the
 *  root stays inside what the pose's own reach leaves over, which is what
 *  `rootLimit` enforces on the one drag that moves it. */
export const STAGE = {
  minX: -MAX_REACH,
  maxX: MAX_REACH,
  minY: ROOT_REST_Y - MAX_REACH,
  maxY: ROOT_REST_Y + MAX_REACH,
};

/**
 * Rotate a rig-space point by the view quat `q` (see {@link turnQuat})
 * about the pivot (pivotX, pivotY, 0) — the figure's root, so a translated
 * figure turns about itself — and drop it to the view plane. `px`/`py` are
 * the on-screen point, `pz` the depth (positive = toward the viewer) — the
 * painter's order and the depth buffer both key off it.
 */
export function projectTurn(
  x: number, y: number, z: number, q: Quat, pivotX: number, pivotY: number,
): { px: number; py: number; pz: number } {
  const [rx, ry, rz] = quatRotate(q, x - pivotX, y - pivotY, z);
  return { px: pivotX + rx, py: pivotY + ry, pz: rz };
}

/** The classic view: yaw about the vertical axis through `pivotX`. The
 *  same projection as {@link projectTurn} with the up axis (a turn about
 *  (0, 1) never moves y, so no pivotY is needed). */
export function projectYaw(
  x: number, y: number, z: number, yaw: number, pivotX: number,
): { px: number; py: number; pz: number } {
  return projectTurn(x, y, z, turnQuat(yaw), pivotX, 0);
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
