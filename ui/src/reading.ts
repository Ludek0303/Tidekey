import type { TreeItem } from "./bridge";
import { initFormula, renderHtml } from "./formula";
import { tidyCell, openLink, shortUrl, webHref, BARE_URL, SHORT_WORD_SPACE } from "./livepreview";

/** The note a wikilink names: `Plan` or `Projekty/Plan`, with or without `.md`, any case. */
export function findNote(items: TreeItem[], target: string): TreeItem | undefined {
  const name = target.trim().toLowerCase().replace(/\.md$/, "");
  if (!name) return undefined;
  const exact = `${name}.md`;
  return (
    items.find((i) => i.path.toLowerCase() === exact) ??
    items.find((i) => i.path.toLowerCase().endsWith(`/${exact}`))
  );
}

// Polish typography, as in the live preview: the space after a 1-3 letter word becomes non-breaking. Code keeps its text.
function nbspShortWords(host: HTMLElement): void {
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    if (text.parentElement?.closest("code, pre")) continue;
    const fixed = text.data.replace(SHORT_WORD_SPACE, (m) => m.slice(0, -1) + "\u00a0");
    if (fixed !== text.data) text.data = fixed;
  }
}

// A text split around its bare web addresses; each address is a link shown short, with the full address as href.
function urlParts(data: string): Node[] {
  const parts: Node[] = [];
  let last = 0;
  for (const m of data.matchAll(BARE_URL)) {
    const at = m.index ?? 0;
    const a = document.createElement("a");
    a.href = webHref(m[0]);
    a.textContent = shortUrl(m[0]);
    a.title = m[0];
    parts.push(document.createTextNode(data.slice(last, at)), a);
    last = at + m[0].length;
  }
  parts.push(document.createTextNode(data.slice(last)));
  return parts;
}

function linkBareUrls(host: HTMLElement): void {
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.parentElement?.closest("a, code, pre")) texts.push(node as Text);
  }
  for (const text of texts) {
    if (text.data.search(BARE_URL) >= 0) text.replaceWith(...urlParts(text.data));
  }
}

// Shows a note as rendered Markdown. The HTML comes from the core, which escapes note text.
export class ReadingView {
  private text = "";

  constructor(
    private readonly host: HTMLElement,
    private readonly onLink: (target: string) => void,
    private readonly render: (md: string) => string | null = (md) => renderHtml(md),
    private readonly afterPaint: (host: HTMLElement, md: string) => void = () => {},
  ) {
    host.addEventListener("click", (e) => this.onClick(e));
  }

  show(text: string): void {
    this.text = text;
    if (!this.paint(text)) {
      // Formulas are still loading: show the rendered note as soon as they are ready.
      initFormula().then(
        () => this.paint(this.text),
        () => {},
      );
    }
  }

  // Returns false when the note could not be rendered (the plain-text fallback is shown).
  private paint(text: string): boolean {
    const top = this.host.scrollTop;
    const html = this.render(text);
    if (html === null) {
      const pre = document.createElement("pre");
      pre.textContent = text;
      this.host.replaceChildren(pre);
    } else {
      this.host.innerHTML = html;
      linkBareUrls(this.host);
      this.host.querySelectorAll<HTMLElement>("th, td").forEach((cell) => tidyCell(cell));
      nbspShortWords(this.host);
    }
    // every paint, the plain-text one too: the images of the last paint are gone and their URLs are released
    this.afterPaint(this.host, text);
    this.host.scrollTop = top;
    return html !== null;
  }

  // Links never navigate the app window: web links open elsewhere, note links open the note.
  private onClick(e: MouseEvent): void {
    if (!(e.target instanceof Element)) return;
    const el = e.target.closest(".wikilink, a[href]");
    if (!el) return;
    e.preventDefault();
    openLink(el, this.onLink);
  }
}
