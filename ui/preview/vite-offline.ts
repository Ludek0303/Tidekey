// Two build-time fixes to pptx-browser 4.1.5 (MIT; the changes are named in THIRD_PARTY_NOTICES.txt):
// 1. off the network in the preview frame (PODGLAD-PLAN §5): renderSlide() asks Google Fonts for a stylesheet and waits
//    up to 7 s; the frame's CSP would block that request, but only after the wait.
// 2. render.js reads `defRPr` for the bullet before its `const` line in the same loop (a TDZ error that drops the text
//    of every shape with a bullet); the declaration moves up.
import type { Plugin } from "vite";

const LIB = /[\\/]pptx-browser[\\/]src[\\/]index\.js$/;
const CALL = "await loadGoogleFontsFor(usedFonts, this.themeData);";
const RENDER = /[\\/]pptx-browser[\\/]src[\\/]render\.js$/;
const BULLET = "const bullet = pPr ? parseBullet(pPr, defRPr, themeColors, themeData) : null;";
const DECL = "    const defRPr = g1(pPr, 'defRPr');\n";

export function pptxOffline(): Plugin {
  return {
    name: "pptx-browser-offline",
    transform(code, id) {
      const file = id.split("?")[0];
      if (RENDER.test(file)) {
        if (!code.includes(BULLET) || !code.includes(DECL)) this.error("pptx-browser: render.js changed, check the defRPr fix");
        return code.replace(DECL, "").replace(BULLET, `const defRPr = g1(pPr, 'defRPr');\n    ${BULLET}`);
      }
      if (!LIB.test(file)) return null;
      // another version of the library: failing the build is better than shipping the request
      if (!code.includes(CALL)) this.error("pptx-browser: Google Fonts call not found, the library version changed");
      return code.replace(CALL, "/* fonts: offline (preview frame) */");
    },
  };
}
