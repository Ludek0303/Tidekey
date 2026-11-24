// Types for collect.mjs, so the Vite configs (TypeScript) can import it. The plugins are plain Vite/rolldown plugins.
export function packageDir(id: string): string | null;
export function licenceModules(label: string): { name: string };
export function licenceFiles(): { name: string };
