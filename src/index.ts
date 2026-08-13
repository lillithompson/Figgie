// Figgie — a drag-to-pose stick-figure mannequin in a canvas.
//
//   const rig = createFiggie(canvas, { onPoseChange });
//   rig.setYaw(0.4);           // turn about the up axis (view only)
//   rig.getPose();             // small JSON-able object
//   projectSilhouette(pose, yaw); // depth-sorted 2D shapes for baking
//
// The component is fully self-contained (WebGL, pointer gestures, render
// scheduling); the pure modules it is built from are exported alongside so
// hosts can hit-test, solve or bake without a canvas at all.

export { createFiggie } from './figgie';
export type { FiggieHandle, FiggieOptions } from './figgie';
export {
  defaultPose, normalizeAngle, poseEquals, resolveDrag, sanitizePose, solveWorld,
  viewAxis,
} from './pose';
export type { FiggiePose, WorldJoints } from './pose';
export {
  QUAT_IDENTITY, quatEquals, quatFromAxisAngle, quatMul, quatNormalize, quatRotate,
} from './quat';
export type { Quat } from './quat';
export {
  BODY_BLOBS, BODY_CAPSULES, DRAG_TARGETS, JOINT_IDS, RIG_HEIGHT, SKELETON,
  dragTargetFor, knobRadius,
} from './skeleton';
export type { DragTarget, JointId } from './skeleton';
export { posePrimitives, projectSilhouette } from './primitives';
export type { FlatCapsule, FlatEllipse, FlatPrimitive } from './primitives';
export { fitStage, projectYaw, STAGE } from './view';
export type { Fit } from './view';
export { hitTest, HIT_RADIUS_PX } from './hit';
export { DEFAULT_COLORS } from './render';
export type { RigColors } from './render';
