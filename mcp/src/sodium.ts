import sodiumModule from "libsodium-wrappers";

export type Sodium = typeof sodiumModule;
let loaded = false;
let ready: Promise<Sodium> | null = null;
export const sodium = (): Promise<Sodium> => (ready ??= sodiumModule.ready.then(() => { loaded = true; return sodiumModule; }));
/** Zeroes bytes in place, synchronously (exit handlers cannot wait): sodium.memzero once loaded. */
export function zero(...buffers: (Uint8Array | null | undefined)[]): void {
  for (const b of buffers) if (b && b.length) { if (loaded) sodiumModule.memzero(b); else b.fill(0); }
}
