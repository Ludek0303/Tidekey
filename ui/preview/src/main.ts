// Entry of the preview frame: connects the window events to FrameApp and talks to the app, its parent.
import "./frame.css";
import { PROTOCOL_VERSION, type FromFrame } from "../../src/preview/protocol";
import { FrameApp, swipeDir } from "./app";

// The frame has an opaque origin (location.origin reads "null"), so the server's address comes from this module's URL.
const SERVER = new URL(import.meta.url).origin;
const post = (m: FromFrame, transfer: Transferable[] = []): void => window.parent.postMessage(m, SERVER, transfer);

const host = document.getElementById("host");
if (!host) throw new Error("brak #host");
const app = new FrameApp(host, post);

window.addEventListener("message", (e) => {
  if (e.source !== window.parent || e.origin !== SERVER) return;
  app.receive(e.data);
});
window.addEventListener("keydown", (e) => app.keydown(e));
// A link inside a document (DOCX, PDF, a slide) never navigates the frame: that would tell a server the file was opened.
for (const type of ["click", "auxclick"]) {
  document.addEventListener(type, (e) => {
    if (e.target instanceof Element && e.target.closest("a[href], area[href]")) e.preventDefault();
  }, { capture: true });
}
window.addEventListener("resize", () => app.resize());

// A horizontal touch drag is a swipe to the next or previous file, unless the viewer keeps it (see FrameApp.swipe).
let touch: { x: number; y: number } | null = null;
window.addEventListener("pointerdown", (e) => {
  if (e.pointerType === "touch") touch = { x: e.clientX, y: e.clientY };
});
window.addEventListener("pointercancel", () => {
  touch = null;
});
window.addEventListener("pointerup", (e) => {
  const start = touch;
  touch = null;
  if (!start || e.pointerType !== "touch") return;
  const dir = swipeDir(e.clientX - start.x, e.clientY - start.y);
  if (dir !== 0) app.swipe(dir);
});

post({ v: PROTOCOL_VERSION, type: "ready" });
