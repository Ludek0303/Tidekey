// Quick Look style window over the app. The bar, the states, the keys and the focus are ours; the bytes go to the
// sandboxed frame (frame.ts), which parses and draws them.
import { icon, iconButton, type IconName } from "../icons";
import { formatSize } from "../filestore";
import { on } from "../bus";
import { parse as parseFileText } from "../ocr/filetext";
import { badgeText, isRecognizable, ocrBoard, requestRecognize, type OcrStatusEvent } from "../ocr/status";
import { errorText, openMenu, toast, type MenuEntry } from "../widgets";
import { FrameHost, PreviewFailure, currentTheme, type FrameEvents } from "./frame";
import { foldText } from "../bridge";
import { MAX_SIZE, VIEWER_LABEL, detect, guess, type ViewerId } from "./formats";
import { encodeThumb, type LayerView, type PreviewItem } from "./items";
import type { ErrorCode } from "./protocol";

export const VIDEO_HEAD_BYTES = 16 * 1024 * 1024;
const MIB = 1024 * 1024;
const NAME_END = 12;
const SWIPE_PX = 60;
const OFFLINE_TEXT = "Plik jest niedostępny bez połączenia.";
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// Frame errors as the user reads them (plan §6). "unsupported" and "too-large" have their own cards.
const REASON: Record<Exclude<ErrorCode, "unsupported" | "too-large">, string> = {
  corrupt: "Plik jest uszkodzony albo ma nieznany format.",
  codec: "Ta przeglądarka nie odtwarza tego kodeka.",
  timeout: "Przygotowanie podglądu trwało za długo.",
  internal: "Coś poszło nie tak w podglądzie.",
};

const VIEWER_ICON: Record<ViewerId, IconName> = {
  image: "image", tiff: "image", psd: "image", heic: "image", text: "code", csv: "sheet", audio: "music",
  font: "type", zip: "file-archive", video: "video", pdf: "file-text", docx: "file-text", doc: "file-text",
  sheet: "sheet", pptx: "presentation", ppt: "presentation", model3d: "box", step: "box", pointcloud: "box",
  cad: "pen-tool", none: "file",
};

export interface PreviewDeps {
  createFrame(parent: HTMLElement, events: FrameEvents): Pick<FrameHost, "element" | "open" | "frame" | "command" | "dispose" | "destroy"> & Partial<Pick<FrameHost, "setTheme">>;
  encodeThumb(pixels: ArrayBuffer, width: number, height: number): Promise<Blob | null>;
  online(): boolean; // navigator.onLine
}

interface Thumb {
  blob: Blob;
  width: number;
  height: number;
  durationMs: number | undefined;
}

const defaults: PreviewDeps = {
  createFrame: (parent, events) => new FrameHost(parent, events),
  encodeThumb,
  online: () => navigator.onLine,
};

let closeOpen: (() => void) | null = null;
let seq = 0;

/** Name cut in the middle: the start may be ellipsised by CSS, the end (last characters, extension) never is. */
export function splitName(name: string): [string, string] {
  const parts = [...graphemes.segment(name)].map((s) => s.segment);
  const cut = Math.max(0, parts.length - NAME_END);
  return [parts.slice(0, cut).join(""), parts.slice(cut).join("")];
}

/** Opens the "Tekst" tab on this page, with the first `mark` on it highlighted (a search hit). */
export interface TextFocus { page: number; mark: string }

/** Opens the window on items[index]; returns the function that closes it. An open window closes first (one at a time). */
export function openPreview(items: PreviewItem[], index: number, opts: { bySpace?: boolean; deps?: Partial<PreviewDeps>; text?: TextFocus } = {}): () => void {
  closeOpen?.();
  if (items.length === 0) return () => undefined;
  const deps: PreviewDeps = { ...defaults, ...opts.deps };
  const bySpace = opts.bySpace ?? false;
  const returnTo = document.activeElement as HTMLElement | null;
  const titleId = `podglad-nazwa-${++seq}`;
  let current = Math.min(Math.max(index, 0), items.length - 1);
  let run = 0; // token of the latest load: a step with an older token does nothing
  let ctl: AbortController | null = null;
  let closed = false;
  let touch: { x: number; y: number } | null = null;
  const focus = opts.text ? { ...opts.text, key: items[current].key } : null;

  // The bar, as in the mockup (docs/design/podglad/makiety.html).
  const root = el("div", "podglad");
  const okno = el("div", "podglad-okno");
  okno.setAttribute("role", "dialog");
  okno.setAttribute("aria-modal", "true");
  okno.setAttribute("aria-labelledby", titleId);

  let ikona = pasekIcon("file");
  const nazwaStart = el("span", "podglad-nazwa-poczatek");
  const nazwaKoniec = el("span", "podglad-nazwa-koniec");
  const title = el("strong", "", nazwaStart, nazwaKoniec);
  title.id = titleId;
  const opis = el("span", "podglad-opis");
  const prevBtn = button("chevron-left", "Poprzedni plik", "tylko-ikona");
  const licznik = el("span", "podglad-licznik");
  const nextBtn = button("chevron-right", "Następny plik", "tylko-ikona");
  const nav = el("div", "podglad-nav", prevBtn, licznik, nextBtn);
  nav.hidden = items.length < 2;
  const textBtn = button("file-text", "Tekst", "pelne podglad-tekst-przycisk", true);
  textBtn.setAttribute("aria-pressed", "false");
  textBtn.hidden = true;
  const downloadBtn = button("download", "Pobierz", "pelne", true);
  const openBtn = button("external-link", "Otwórz", "pelne", true);
  const moreBtn = button("ellipsis", "Więcej", "tylko-ikona podglad-wiecej");
  const closeBtn = button("x", "Zamknij", "tylko-ikona");
  const pasek = el(
    "header", "podglad-pasek", ikona, el("div", "podglad-nazwa", title, opis), nav,
    el("span", "podglad-separator"), el("div", "podglad-akcje", textBtn, downloadBtn, openBtn, moreBtn, closeBtn),
  );

  const tresc = el("div", "podglad-tresc");
  const stan = el("div", "podglad-stan");
  stan.setAttribute("role", "status");
  stan.setAttribute("aria-live", "polite");
  const live = el("div", "sr-only");
  live.setAttribute("aria-live", "polite");

  const events: FrameEvents = {
    onStatus: (text) => {
      live.textContent = text;
    },
    onNav: (dir) => go(dir),
    onClose: (fromSpace) => {
      if (!fromSpace || bySpace) closeWindow();
    },
    onDownload: () => items[current].download(),
  };
  const frame = deps.createFrame(tresc, events);
  frame.element.classList.add("podglad-ramka");
  // the text tab covers the frame and the state (it keeps them as they are, so closing it shows the same thing again)
  const textPane = el("section", "podglad-tekst");
  textPane.hidden = true;
  textPane.setAttribute("aria-label", "Tekst pliku");
  tresc.append(stan, frame.element, textPane); // the state sits before the frame: CSS hides the frame while it shows
  // Tab out of the frame lands here (keys inside the frame never reach this document), and goes on to the first control
  const guard = el("span", "podglad-straznik");
  guard.tabIndex = 0;
  guard.addEventListener("focus", () => {
    [...pasek.querySelectorAll<HTMLElement>("button:not(:disabled)")].find(visible)?.focus();
  });
  okno.append(pasek, tresc, guard);
  root.append(okno, live);
  document.body.append(root);

  textBtn.addEventListener("click", toggleText);
  downloadBtn.addEventListener("click", () => items[current].download());
  openBtn.addEventListener("click", () => items[current].open());
  prevBtn.addEventListener("click", () => go(-1));
  nextBtn.addEventListener("click", () => go(1));
  closeBtn.addEventListener("click", closeWindow);
  moreBtn.addEventListener("click", () => {
    const r = moreBtn.getBoundingClientRect();
    const entries: MenuEntry[] = [
      { label: "Pobierz", icon: "download", run: () => items[current].download() },
      { label: "Otwórz", icon: "external-link", run: () => items[current].open() },
    ];
    if (current > 0) entries.push({ label: "Poprzedni plik", icon: "chevron-left", run: () => go(-1) });
    if (current < items.length - 1) entries.push({ label: "Następny plik", icon: "chevron-right", run: () => go(1) });
    openMenu(r.left, r.bottom, entries);
  });
  root.addEventListener("keydown", onKey);

  // Narrow window: a horizontal swipe on the bar or on the state moves to the neighbouring file.
  const swipeStart = (e: PointerEvent): void => {
    touch = e.pointerType === "touch" ? { x: e.clientX, y: e.clientY } : null;
  };
  const swipeEnd = (e: PointerEvent): void => {
    const from = touch;
    touch = null;
    if (!from) return;
    const dx = e.clientX - from.x;
    const dy = e.clientY - from.y;
    if (Math.abs(dx) >= SWIPE_PX && Math.abs(dx) >= 2 * Math.abs(dy)) go(dx < 0 ? 1 : -1);
  };
  for (const zone of [pasek, stan]) {
    zone.addEventListener("pointerdown", swipeStart);
    zone.addEventListener("pointerup", swipeEnd);
  }

  // Focus stays in the window: anything focused outside it (not the menu, which lives outside) goes back to Zamknij.
  const onFocusIn = (e: FocusEvent): void => {
    const target = e.target;
    if (target instanceof Node && !root.contains(target) && !(target instanceof Element && target.closest(".menu"))) closeBtn.focus();
  };
  document.addEventListener("focusin", onFocusIn);
  // a theme switched while the window is open reaches the frame too (it only knows the colours it was given)
  const themeWatch = new MutationObserver(() => frame.setTheme?.(currentTheme()));
  themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style", "data-accent"] });

  function closeWindow(): void {
    if (closed) return;
    closed = true;
    if (closeOpen === closeWindow) closeOpen = null;
    run++; // any step still running sees a stale token and stops
    ctl?.abort();
    closeText();
    offStatus();
    frame.destroy();
    document.removeEventListener("focusin", onFocusIn);
    themeWatch.disconnect();
    root.remove();
    if (returnTo?.isConnected) returnTo.focus();
  }

  function go(dir: -1 | 1): void {
    const target = current + dir;
    if (target < 0 || target >= items.length) return;
    current = target;
    show();
  }

  function show(): void {
    ctl?.abort();
    closeText();
    frame.dispose();
    ctl = new AbortController();
    setNav();
    void load(items[current], ++run, ctl.signal);
  }

  function setNav(): void {
    textBtn.hidden = items[current].text === null;
    licznik.textContent = `${current + 1} z ${items.length}`;
    prevBtn.disabled = current === 0;
    nextBtn.disabled = current === items.length - 1;
  }

  function setHeader(item: PreviewItem, viewer: ViewerId): void {
    const [start, end] = splitName(item.name);
    nazwaStart.textContent = start;
    nazwaKoniec.textContent = end;
    title.title = item.name;
    opis.textContent = `${VIEWER_LABEL[viewer]} · ${formatSize(item.size)}`;
    const next = pasekIcon(VIEWER_ICON[viewer]);
    ikona.replaceWith(next);
    ikona = next;
  }

  async function load(item: PreviewItem, token: number, signal: AbortSignal): Promise<void> {
    const info = guess(item.mime, item.name);
    let viewer: ViewerId = info.viewer;
    setHeader(item, viewer);
    try {
      if (viewer === "none") return unsupported(item);
      if (viewer === "video") return await video(item, token, signal);
      if (item.size > info.maxSize) return tooLarge(item, info.maxSize);
      const onProgress = loading("Pobieranie i odszyfrowywanie…", true);
      const bytes = await (await item.read({ signal, onProgress })).arrayBuffer();
      if (token !== run) return;
      viewer = detect(new Uint8Array(bytes), item.mime, item.name);
      setHeader(item, viewer);
      if (viewer === "none") return unsupported(item);
      if (bytes.byteLength > MAX_SIZE[viewer]) return tooLarge(item, MAX_SIZE[viewer]);
      loading("Przygotowuję podgląd…", false);
      await frame.open({ name: item.name, mime: item.mime, size: item.size, viewer, bytes });
      if (token === run) showFrame();
    } catch (err) {
      if (signal.aborted || token !== run) return;
      failed(item, viewer, err);
    }
  }

  // Videos show only their first frame. A frame that cannot be made becomes a card with Open and Download.
  async function video(item: PreviewItem, token: number, signal: AbortSignal): Promise<void> {
    const onProgress = loading("Pobieranie i odszyfrowywanie…", true);
    const pending = item.thumb ? item.readThumb({ signal, onProgress }) : null;
    const saved = pending ? await pending : null;
    if (token !== run) return;
    if (saved) return showStill(item, token, saved, item.durationMs ?? undefined);
    const head = await item.readHead(VIDEO_HEAD_BYTES, { signal, onProgress });
    if (token !== run) return;
    loading("Przygotowuję podgląd…", false);
    let made: Thumb | null;
    try {
      made = await firstFrame(item, head.blob);
    } catch {
      made = null;
    }
    if (token !== run) return;
    if (!made) return showStan(videoCard(item));
    // The thumbnail is saved for next time; a refused save is not the user's problem.
    item.saveThumb({ blob: made.blob, width: made.width, height: made.height, durationMs: made.durationMs }).catch(() => undefined);
    return showStill(item, token, made.blob, made.durationMs);
  }

  async function firstFrame(item: PreviewItem, head: Blob): Promise<Thumb | null> {
    const picture = await frame.frame({ name: item.name, mime: item.mime, bytes: await head.arrayBuffer() });
    const blob = await deps.encodeThumb(picture.pixels, picture.width, picture.height);
    if (!blob) return null;
    return { blob, width: picture.width, height: picture.height, durationMs: picture.durationMs ?? item.durationMs ?? undefined };
  }

  async function showStill(item: PreviewItem, token: number, blob: Blob, durationMs: number | undefined): Promise<void> {
    try {
      await frame.open({ name: item.name, mime: blob.type, size: blob.size, viewer: "image", bytes: await blob.arrayBuffer(), label: "first-frame", durationMs });
    } catch {
      if (token === run) showStan(videoCard(item));
      return;
    }
    if (token === run) showFrame();
  }

  function failed(item: PreviewItem, viewer: ViewerId, err: unknown): void {
    if (err instanceof PreviewFailure) {
      if (err.code === "unsupported") return unsupported(item);
      if (err.code === "too-large") return tooLarge(item, MAX_SIZE[viewer]);
      return showStan(errorCard(item, REASON[err.code]));
    }
    if (!deps.online() || errorText(err) === OFFLINE_TEXT) return showStan(offlineCard());
    showStan(errorCard(item, errorText(err)));
  }

  function unsupported(item: PreviewItem): void {
    showStan(card("file", item.name, [opis.textContent ?? "", "Tego rodzaju pliku nie da się podejrzeć."], [
      action("Pobierz", () => item.download(), true),
      action("Otwórz", () => item.open()),
    ]));
  }

  function tooLarge(item: PreviewItem, limit: number): void {
    showStan(card("file", item.name, [opis.textContent ?? "", `Ten plik jest za duży na podgląd (limit ${formatSize(limit)}).`], [
      action("Pobierz", () => item.download(), true),
    ]));
  }

  function videoCard(item: PreviewItem): HTMLElement {
    return card("video", item.name, [opis.textContent ?? "", "Pierwszej klatki nie da się pokazać."], [
      action("Otwórz", () => item.open()),
      action("Pobierz", () => item.download(), true),
    ]);
  }

  function errorCard(item: PreviewItem, reason: string): HTMLElement {
    return card("circle-alert", "Nie można wyświetlić tego pliku", [reason], [action("Pobierz", () => item.download(), true)], true);
  }

  function offlineCard(): HTMLElement {
    return card("wifi-off", "Plik jest niedostępny bez połączenia", ["Połącz się z internetem i spróbuj ponownie."], [
      action("Spróbuj ponownie", () => show(), true),
    ]);
  }

  // The loading state takes the frame's place. With `withBar`, returns the callback that fills the bar (bytes).
  function loading(text: string, withBar: boolean): (done: number, total: number) => void {
    const note = el("span");
    note.textContent = text;
    const box = el("div", "podglad-ladowanie", note);
    let update: (done: number, total: number) => void = () => undefined;
    if (withBar) {
      const fill = el("span");
      const bar = el("div", "podglad-postep", fill);
      bar.setAttribute("role", "progressbar");
      bar.setAttribute("aria-valuemin", "0");
      bar.setAttribute("aria-valuemax", "100");
      const amount = el("span");
      box.append(bar, amount);
      update = (done, total) => {
        const pct = total > 0 ? Math.min(100, Math.round((done * 100) / total)) : 0;
        fill.style.width = `${pct}%`;
        bar.setAttribute("aria-valuenow", String(pct));
        amount.textContent = `${mb(done)} z ${mb(total)} MB`;
      };
    }
    showStan(box);
    return update;
  }

  // --- The "Tekst" tab (OCR §3.6): the file's text layer page by page. Refilled when the file's status changes (a
  // recognition ends while the tab is open).
  let textOpen = false;
  let textCtl: AbortController | null = null;
  const offStatus = on("ocr:status", (detail) => {
    if (textOpen && (detail as OcrStatusEvent).fileId === items[current].key) fillText();
  });

  function toggleText(): void {
    if (textOpen) return closeText();
    if (!items[current].text) return;
    textOpen = true;
    textBtn.setAttribute("aria-pressed", "true");
    textPane.hidden = false;
    fillText();
  }

  function closeText(): void {
    textCtl?.abort();
    textCtl = null;
    textOpen = false;
    textBtn.setAttribute("aria-pressed", "false");
    textPane.hidden = true;
    textPane.replaceChildren();
  }

  function fillText(): void {
    const item = items[current];
    if (!item.text) return closeText();
    textCtl?.abort();
    const ctl = new AbortController();
    textCtl = ctl;
    textPane.replaceChildren(el("p", "podglad-tekst-stan", document.createTextNode("Wczytywanie tekstu…")));
    item.text.load({ signal: ctl.signal }).then(
      (view) => { if (!ctl.signal.aborted) textPane.replaceChildren(textContent(item, view)); },
      () => { if (!ctl.signal.aborted) textPane.replaceChildren(el("p", "podglad-tekst-stan is-blad", document.createTextNode("Nie udało się wczytać tekstu tego pliku."))); },
    );
  }

  function textContent(item: PreviewItem, view: LayerView | null): HTMLElement {
    const box = el("div", "podglad-tekst-obsah");
    const doc = view ? parseFileText(view.markdown) : null;
    const bar = el("div", "podglad-tekst-pasek");
    if (doc) {
      bar.append(el("span", "podglad-jakosc", document.createTextNode(`Jakość: ${Math.round(doc.quality * 100)} %`)));
      if (doc.flags.length > 0) bar.append(el("span", "podglad-jakosc is-niska", document.createTextNode(doc.flags.join(", "))));
      const copy = el("button", "btn", document.createTextNode("Kopiuj tekst"));
      copy.type = "button";
      copy.addEventListener("click", () => {
        const text = doc.pages.map((p) => p.text).filter((t) => t !== "").join("\n\n");
        navigator.clipboard.writeText(text).then(() => toast("Skopiowano tekst."), () => toast("Nie udało się skopiować tekstu.", true));
      });
      bar.append(copy);
    }
    if (ocrBoard.writable && isRecognizable(item.mime)) bar.append(recognizeButton(item, doc !== null));
    box.append(bar);
    if (!doc) {
      const status = ocrBoard.statusOf(item.key);
      const text = status ? `Stan: ${badgeText(status, ocrBoard.progressOf(item.key))}.` : "Tekst tego pliku nie jest jeszcze rozpoznany.";
      box.append(el("p", "podglad-tekst-stan", document.createTextNode(text)));
      return box;
    }
    for (const page of doc.pages) {
      const head = el("h3", "", document.createTextNode(doc.image ? "Obraz" : `Strona ${page.n}`));
      if (page.lowQuality) head.append(" ", el("span", "podglad-jakosc is-niska", document.createTextNode("niska jakość")));
      const marked = focus?.key === item.key && focus.page === page.n ? focus.mark : "";
      const section = el("section", "podglad-tekst-strona", head, el("pre", "", ...highlight(page.text || "brak tekstu", marked)));
      section.dataset.strona = String(page.n);
      box.append(section);
    }
    if (focus?.key === item.key) box.querySelector<HTMLElement>(`[data-strona="${focus.page}"]`)?.scrollIntoView?.({ block: "start" });
    return box;
  }

  // Editors and up only. A layer that exists stays (the same extractor version writes the same id), so "again" is disabled.
  function recognizeButton(item: PreviewItem, hasText: boolean): HTMLButtonElement {
    const button = el("button", "btn", document.createTextNode(hasText ? "Rozpoznaj ponownie" : "Rozpoznaj tekst"));
    button.type = "button";
    if (hasText) {
      button.disabled = true;
      button.title = "Tekst rozpoznany tą wersją jest już zapisany";
    } else {
      button.addEventListener("click", () => {
        requestRecognize(item.key);
        toast("Tekst zostanie rozpoznany w kolejce.");
      });
    }
    return button;
  }

  // Showing a state hides the frame behind it (CSS, see preview.css); showing the frame removes the state.
  function showStan(node: HTMLElement): void {
    stan.replaceChildren(node);
    stan.hidden = false;
  }

  function showFrame(): void {
    stan.replaceChildren();
    stan.hidden = true;
  }

  function onKey(e: KeyboardEvent): void {
    const k = e.key;
    if (k === "Escape") {
      e.preventDefault();
      closeWindow();
    } else if (k === "ArrowLeft") go(-1);
    else if (k === "ArrowRight") go(1);
    else if (k === " " && bySpace && !(e.target instanceof HTMLButtonElement)) closeWindow();
    else if (k === "+" || k === "=") frame.command("zoom-in");
    else if (k === "-") frame.command("zoom-out");
    else if (k === "0") frame.command("zoom-reset");
    else if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === "s") {
      e.preventDefault();
      items[current].download();
    } else if (k === "Tab") trap(e);
  }

  // Tab wraps at the ends of the window's controls and the frame; between them the browser moves focus.
  function trap(e: KeyboardEvent): void {
    const list = [...root.querySelectorAll<HTMLElement>("button:not(:disabled), iframe")].filter(visible);
    if (list.length === 0) return;
    const first = list[0];
    const last = list[list.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  closeOpen = closeWindow;
  closeBtn.focus();
  show();
  if (focus) toggleText();
  return closeWindow;
}

/** The text as nodes, its first `term` in a <mark>. Matches fold case and diacritics, as the index does. */
function highlight(text: string, term: string): Node[] {
  const chars = [...text];
  const folds = chars.map((c) => foldText(c));
  const want = foldText(term);
  const at = want === "" ? -1 : folds.join("").indexOf(want);
  if (at < 0) return [document.createTextNode(text)];
  // the characters that hold the folded match: from the one at `at` to the last one of the match
  let pos = 0;
  let start = -1;
  let end = chars.length;
  for (let i = 0; i < chars.length; i++) {
    if (start < 0 && pos + folds[i].length > at) start = i;
    if (pos >= at + want.length) {
      end = i;
      break;
    }
    pos += folds[i].length;
  }
  return [
    document.createTextNode(chars.slice(0, start).join("")),
    el("mark", "", document.createTextNode(chars.slice(start, end).join(""))),
    document.createTextNode(chars.slice(end).join("")),
  ];
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", ...children: Node[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  node.append(...children);
  return node;
}

function button(name: IconName, label: string, cls: string, withText = false): HTMLButtonElement {
  const b = iconButton(name, label, `podglad-przycisk ${cls}`);
  if (withText) {
    const text = el("span", "podglad-etykieta");
    text.textContent = label;
    b.append(text);
  }
  return b;
}

function action(label: string, doIt: () => void, primary = false): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = primary ? "btn btn-primary" : "btn";
  b.textContent = label;
  b.addEventListener("click", doIt);
  return b;
}

function card(name: IconName, heading: string, lines: string[], actions: HTMLButtonElement[], error = false): HTMLElement {
  const box = el("div", error ? "podglad-karta is-blad" : "podglad-karta");
  const big = icon(name);
  big.classList.add("duza-ikona");
  const h2 = el("h2");
  h2.textContent = heading;
  const ps = lines.map((line) => {
    const p = el("p");
    p.textContent = line;
    return p;
  });
  box.append(big, h2, ...ps, el("div", "akcje", ...actions));
  return box;
}

function pasekIcon(name: IconName): SVGElement {
  const svg = icon(name);
  svg.classList.add("podglad-ikona");
  return svg;
}

// Controls the window hides (the narrow bar, a state that is not shown) take no focus.
function visible(node: HTMLElement): boolean {
  const style = getComputedStyle(node);
  return !node.closest("[hidden]") && style.display !== "none" && style.visibility !== "hidden";
}

const mb = (bytes: number): string => (bytes / MIB).toLocaleString("pl-PL", { maximumFractionDigits: 1 });
