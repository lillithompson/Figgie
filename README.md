# Figgie

A drag-to-pose stick-figure mannequin in a `<canvas>`. WebGL, zero
dependencies, fully encapsulated — hand it a canvas, get back a poseable
animator's rig proportioned after AnimationMentor's Stewie: ball head with
dot eyes, thin tan capsule limbs, pear torso, paddle hands, wedge feet.

```ts
import { createFiggie, projectSilhouette } from 'figgie';

const rig = createFiggie(canvas, {
  onPoseChange: (pose, { live }) => { /* pose is plain JSON */ },
});
rig.setYaw(0.5);      // turn the figure about its up axis (view only)
rig.setYaw({ upX: 1, upY: 0, yaw: 0.5 }); // …or about any rig-plane axis
rig.getPose();        // serialize; rig.setPose(json) restores
rig.destroy();
```

## Posing model

Every drag rotates about the axis **normal to the viewport** — the one
interaction rule. Grab a joint and it orbits its parent on a circle lying
in the view plane, at its current apparent radius, tracking the finger's
angle exactly. Because the yaw slider changes which world axis that is,
turning the figure and dragging builds genuinely three-dimensional poses
out of flat, screen-plane gestures: face front and swing an arm sideways,
quarter-turn and swing the same arm forward.

- **hips** — the whole figure translates (it is the yaw pivot, so the
  finger maps exactly at any turn; clamped to the stage);
- **spine, chest, head, shoulders, elbows, knees** — FK about the view
  normal; everything downstream rides along rigidly;
- **wrists, ankles** — 2-bone IK in the view plane on the chain's
  *apparent* (projected) lengths, preserving the current bend side and
  whatever depth the chain holds.

Pose state is one unit quaternion per bone plus a root offset — a small
JSON object (`sanitizePose` makes loading it unconditionally safe, and
reads the older one-angle-per-bone planar format losslessly). The **turn**
is a *view* transform, not part of the pose: a plain number is the classic
yaw about the up axis; a full `Turn { upX, upY, yaw }` spins about any
axis in the rig's plane — for hosts that show the rig through their own
transform (mirrored, rotated) and want their turn control to track the
axis the viewer sees as vertical. There is no other camera control.

## Rendering

WebGL1, two static meshes (sphere + open cylinder), one lambert program,
~40 tiny draws per frame — and frames are drawn **on demand only** (one
`requestAnimationFrame` per change), so an idle rig costs zero and a drag
costs one small frame per pointer move. Comfortable at 90 fps inside an
iOS WebView.

`projectSilhouette(pose, turn)` returns the same figure as depth-sorted 2D
capsules and exact projected ellipses, so a host can bake the pose into
its own vector scene (thumbnails, exports) without touching GL.

## Tests

All posing math (FK, IK, hit-testing, projection, fit, silhouette, mesh
generation) is pure and covered by the jest suite: `npm test`.
