// Pure-math modules (skeleton, pose, drag, view, mesh, silhouette) run in
// node; the WebGL renderer and the canvas component are deliberately thin
// and untested here — everything they decide is decided by the pure half.
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
};
