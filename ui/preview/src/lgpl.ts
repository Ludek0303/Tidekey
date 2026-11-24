// Libraries under LGPL are not bundled: each is a separate, unchanged file from vendor/lgpl/ (see its README), copied to
// assets/ at build time (vite-lgpl.ts) and loaded here as a classic script at run time (PODGLAD-PLAN §5).
// No imports: vite-lgpl.ts reads this file from the Vite config, which runs in Node.

// Package and version of each library; must match a MANIFEST.json entry (checked at build time).
export const LIBRARIES = {
  libheif: { pkg: "libheif-js", version: "1.23.5" },
} as const;

export type LgplLibrary = keyof typeof LIBRARIES;
export type LgplFile = "libheif.js" | "libheif.wasm" | "LICENSE";

/** lgpl-<package>-<version>-<file>; the licence is published as LICENSE.txt. */
export function lgplPublishedName(pkg: string, version: string, file: string): string {
  return `lgpl-${pkg}-${version}-${file === "LICENSE" ? "LICENSE.txt" : file}`;
}

/** Path of a library file inside the frame's assets, relative to /preview/. */
export function lgplAssetPath(lib: LgplLibrary, file: LgplFile): string {
  const { pkg, version } = LIBRARIES[lib];
  return `assets/${lgplPublishedName(pkg, version, file)}`;
}

/** Address of the library's script; the frame's CSP allows scripts from /preview/. */
export function lgplUrl(lib: LgplLibrary): string {
  return `/preview/${lgplAssetPath(lib, "libheif.js")}`;
}

const loaded = new Map<LgplLibrary, Promise<void>>();

/** Loads the library's script once per frame. A failed load is forgotten, so the next file tries again. */
export function loadLgplScript(lib: LgplLibrary): Promise<void> {
  let p = loaded.get(lib);
  if (!p) {
    p = new Promise<void>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = lgplUrl(lib);
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`Nie wczytano ${lib}`));
      document.head.append(script);
    });
    loaded.set(lib, p);
    p.catch(() => loaded.delete(lib));
  }
  return p;
}
