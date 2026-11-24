// App-wide events on a DOM EventTarget. Features emit ui:* events; modules listen for them.
const bus = new EventTarget();

export function emit(name: string, detail?: unknown): void {
  bus.dispatchEvent(new CustomEvent(name, { detail }));
}

export function on(name: string, cb: (detail: unknown) => void): () => void {
  const listener = (e: Event) => cb((e as CustomEvent).detail);
  bus.addEventListener(name, listener);
  return () => bus.removeEventListener(name, listener);
}

