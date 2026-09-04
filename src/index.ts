// Figgie — a drag-to-pose stick-figure mannequin in a canvas.
//
//   const rig = createFiggie(canvas, { onPoseChange });
//   rig.setYaw(0.4);           // turn about the up axis (view only)
//   rig.setYaw({ upX: 1, upY: 0, yaw: 0.4 }); // …or any rig-plane axis
//   rig.getPose();             // small JSON-able object
//   projectSilhouette(pose, turn); // depth-sorted 2D shapes for baking
//
// The component is fully self-contained (WebGL, pointer gestures, render
// scheduling); the pure modules it is built from are exported alongside so
// hosts can hit-test, solve or bake without a canvas at all.

export { createFiggie } from './figgie';
export type { FiggieHandle, FiggieOptions } from './figgie';
export {
  defaultPose, normalizeAngle, poseEquals, poseReach, resolveDrag, rootLimit, sanitizePose,
  solveWorld, viewAxis,
} from './pose';
export type { FiggiePose, WorldJoints } from './pose';
export { PUSH_FALLOFF_K, pushFalloff, pushPose } from './push';
export {
  QUAT_IDENTITY, quatEquals, quatFromAxisAngle, quatMul, quatNormalize, quatRotate,
} from './quat';
export type { Quat } from './quat';
export {
  BODY_BLOBS, BODY_CAPSULES, DRAG_TARGETS, HAND_SPAN, JOINT_IDS, MAX_REACH, PUSH_ROOM,
  RIG_HEIGHT, ROOT_REST_Y, SKELETON, STAGE_REACH, dragTargetFor, jointBound, knobRadius,
} from './skeleton';
export type { DragTarget, JointId } from './skeleton';
export { posePrimitives, projectSilhouette } from './primitives';
export type { FlatCapsule, FlatEllipse, FlatPrimitive, WorldPrimitive } from './primitives';
export { buildInkDraw, fillBatch, inkBatch, inkVector, sketchFills, sketchInk } from './ink';
export {
  BALL_BEND_RANGE, FINGER_COLUMN, FIST_RANGE, HAND_STRAIGHT_AT, HEAD_COLUMN, HEAD_RANGE,
  RIG_SPIN_RANGE, SPINE_COLUMN, SPINE_RANGE,
  SPREAD_RANGE, TWIST_RANGE, WRIST_BEND_RANGE, bendBall, bendWrist, centered, curlHand, flexFoot,
  rotateRig, shapeHead, shapeSpine, spreadHand, twistAnkle, twistWrist,
} from './shape';
export type { HeadShape, RigSpin, Side, SpineShape } from './shape';
export type { InkBatch, InkDraw, InkFill, InkPoint, InkPoly, InkStroke } from './ink';
export { fitStage, projectTurn, projectYaw, STAGE, turnQuat } from './view';
export type { Fit, Turn, TurnLike } from './view';
export { hitTest, HIT_RADIUS_PX } from './hit';
export { DEFAULT_COLORS } from './render';
export type { RigColors, RigShader } from './render';
