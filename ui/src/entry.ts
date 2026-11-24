// The page's entry: /prywatnosc, /regulamin and /pomoc render alone, without loading the app; anything else starts it.
// The cookie notice is for the web only (the desktop app sets no cookies).
import { publicPage, renderPage, showCookieNotice } from "./privacy";
import "./settings"; // applies the stored theme on import, so the public pages and the login follow it too

const page = publicPage(location.pathname);
if (page) renderPage(document.getElementById("app")!, page);
else {
  if (!("__TAURI_INTERNALS__" in window)) showCookieNotice();
  void import("./main");
}
