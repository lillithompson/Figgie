/**
 * What a rig leaves behind when it goes.
 *
 * A browser keeps only a handful of live WebGL contexts, and a host that
 * mounts one rig per page burns through them. Dropping the canvas is not
 * enough — the context is reclaimed whenever the element is collected,
 * which is no schedule at all — so `destroy` has to hand it back, or the
 * next `createFiggie` can be refused for no reason but timing.
 */

import { createFiggie } from '../figgie';

/** A WebGL context that answers every call, and records the one thing
 *  this file is about. */
function fakeGl(): { gl: WebGLRenderingContext; lost: () => number } {
  let losses = 0;
  const loseContext = { loseContext: () => { losses += 1; } };
  const gl = new Proxy({} as Record<string, unknown>, {
    get(_t, prop: string) {
      // Enum constants (COMPILE_STATUS, TRIANGLES, …) read as numbers.
      if (prop === Symbol.toPrimitive as unknown as string) return undefined;
      if (prop === 'getExtension') return (name: string) => (name === 'WEBGL_lose_context' ? loseContext : null);
      // The compile/link checks must pass, and every lookup must hand
      // back something truthy for the renderer to hold on to.
      if (prop === 'getShaderParameter' || prop === 'getProgramParameter') return () => true;
      if (prop.startsWith('get') || prop.startsWith('create')) return () => ({});
      if (/^[A-Z_]+$/.test(prop)) return 1;
      return () => undefined;
    },
  }) as unknown as WebGLRenderingContext;
  return { gl, lost: () => losses };
}

function fakeCanvas(gl: WebGLRenderingContext): HTMLCanvasElement {
  return {
    getContext: () => gl,
    clientWidth: 100,
    clientHeight: 100,
    width: 100,
    height: 100,
    style: {},
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  } as unknown as HTMLCanvasElement;
}

describe('destroy', () => {
  const realRaf = globalThis.requestAnimationFrame;
  beforeAll(() => {
    globalThis.requestAnimationFrame = (() => 0) as typeof requestAnimationFrame;
  });
  afterAll(() => { globalThis.requestAnimationFrame = realRaf; });

  it('releases the WebGL context, not just the objects in it', () => {
    const { gl, lost } = fakeGl();
    const rig = createFiggie(fakeCanvas(gl), { interactive: false, shader: 'npr' });
    expect(lost()).toBe(0);
    rig.destroy();
    expect(lost()).toBe(1);
  });

  it('is survivable where the extension is missing', () => {
    const gl = new Proxy({} as Record<string, unknown>, {
      get(_t, prop: string) {
        if (prop === 'getExtension') return () => null;
        if (prop === 'getShaderParameter' || prop === 'getProgramParameter') return () => true;
        if (prop.startsWith('get') || prop.startsWith('create')) return () => ({});
        if (/^[A-Z_]+$/.test(prop)) return 1;
        return () => undefined;
      },
    }) as unknown as WebGLRenderingContext;
    const rig = createFiggie(fakeCanvas(gl), { interactive: false });
    expect(() => rig.destroy()).not.toThrow();
  });
});
