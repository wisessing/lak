/**
 * Run three.js's `setSession` with the classic `XRWebGLLayer`.
 *
 * three.js draws into an `XRProjectionLayer` whenever the browser offers
 * `XRWebGLBinding.prototype.createProjectionLayer`, whether or not the session
 * enabled the `layers` feature. Chrome 156 offers it, and on a Galaxy S24
 * Ultra the projection layer is never composited over the camera: every frame
 * was drawn and nothing appeared, reticle included (29 October 2026). The
 * `XRWebGLLayer` path is the one Chrome's handheld AR has always composited, so
 * the method is hidden for the length of the call and put back unchanged.
 */
export async function withWebGLLayer<T>(fn: () => T | Promise<T>): Promise<T> {
  const proto = (globalThis as { XRWebGLBinding?: { prototype: object } }).XRWebGLBinding?.prototype;
  const descriptor = proto && Object.getOwnPropertyDescriptor(proto, 'createProjectionLayer');
  if (!proto || !descriptor?.configurable) return fn();
  delete (proto as Record<string, unknown>).createProjectionLayer;
  try {
    return await fn();
  } finally {
    Object.defineProperty(proto, 'createProjectionLayer', descriptor);
  }
}
