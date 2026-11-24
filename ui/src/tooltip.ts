// Tooltips for icon buttons: one bubble in document.body, driven by delegated events on `host`.
// The bubble text is data-tip, else aria-label. Native title is too slow and skips keyboard focus.

const SHOW_DELAY = 350;
// A bubble that closed this recently makes the next one appear at once, so sweeping along a bar stays quick.
const WARM_WINDOW = 600;
const GAP = 8;
const MARGIN = 8;
// "Pogrubienie (Ctrl+B)" shows the shortcut in a <kbd>.
const SHORTCUT = /^(.*) \(([^()]+)\)$/;

export function attachTooltips(host: HTMLElement, selector: string): () => void {
  const tip = document.createElement("div");
  tip.className = "ui-tip";
  tip.setAttribute("role", "tooltip");
  tip.setAttribute("aria-hidden", "true");
  document.body.append(tip);

  let anchor: HTMLElement | null = null;
  let visible = false;
  let hiddenAt = -Infinity;
  // Set by keydown and cleared by pointerdown: stands in for :focus-visible, which jsdom does not evaluate.
  let keyboard = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attrs: MutationObserver | undefined;

  const matchOf = (target: EventTarget | null): HTMLElement | null => {
    const el = target instanceof Element ? target.closest<HTMLElement>(selector) : null;
    return el && host.contains(el) ? el : null;
  };

  const textOf = (el: HTMLElement): string => el.dataset.tip ?? el.getAttribute("aria-label") ?? "";

  function render(text: string): void {
    const m = SHORTCUT.exec(text);
    if (m) {
      const kbd = document.createElement("kbd");
      kbd.textContent = m[2];
      tip.replaceChildren(m[1], kbd);
    } else {
      tip.textContent = text;
    }
  }

  function place(el: HTMLElement): void {
    const r = el.getBoundingClientRect();
    const { width, height } = tip.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const left = Math.max(MARGIN, Math.min(cx - width / 2, window.innerWidth - MARGIN - width));
    const below = r.top - GAP - height < 0;
    tip.style.left = `${left}px`;
    tip.style.top = `${below ? r.bottom + GAP : r.top - GAP - height}px`;
    // The arrow stays over the button's centre even when the bubble was pushed sideways.
    tip.style.setProperty("--tip-arrow", `${cx - left}px`);
    tip.classList.toggle("is-below", below);
  }

  function hide(): void {
    clearTimeout(timer);
    timer = undefined;
    attrs?.disconnect();
    attrs = undefined;
    if (visible) hiddenAt = Date.now();
    visible = false;
    anchor = null;
    tip.classList.remove("is-visible");
  }

  function open(el: HTMLElement): void {
    clearTimeout(timer);
    timer = undefined;
    attrs?.disconnect();
    const text = textOf(el);
    if (!el.isConnected || !text) {
      hide();
      return;
    }
    anchor = el;
    visible = true;
    render(text);
    place(el);
    tip.classList.add("is-visible");
    attrs = new MutationObserver(() => {
      const next = textOf(el);
      if (next) {
        render(next);
        place(el);
      } else hide();
    });
    attrs.observe(el, { attributes: true, attributeFilter: ["data-tip", "aria-label"] });
  }

  function request(el: HTMLElement, immediate: boolean): void {
    if (el === anchor) return;
    clearTimeout(timer);
    anchor = el;
    const warm = Date.now() - hiddenAt < WARM_WINDOW;
    if (immediate || visible || warm) open(el);
    else timer = setTimeout(() => open(el), SHOW_DELAY);
  }

  const onPointerOver = (e: PointerEvent) => {
    const el = matchOf(e.target);
    if (el && e.pointerType === "mouse") request(el, false);
  };
  const onPointerOut = (e: PointerEvent) => {
    const el = matchOf(e.target);
    if (el && !el.contains(e.relatedTarget as Node | null)) hide();
  };
  const onFocusIn = (e: FocusEvent) => {
    const el = matchOf(e.target);
    if (el && keyboard) request(el, true);
  };
  const onFocusOut = (e: FocusEvent) => {
    if (matchOf(e.target)) hide();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    keyboard = true;
    if (e.key === "Escape" && visible) hide();
  };
  const onPointerDown = () => {
    keyboard = false;
    hide();
  };
  // Removed buttons take their bubble with them; the observer sees removals anywhere under host.
  const tree = new MutationObserver(() => {
    if (anchor && !anchor.isConnected) hide();
  });

  host.addEventListener("pointerover", onPointerOver);
  host.addEventListener("pointerout", onPointerOut);
  host.addEventListener("focusin", onFocusIn);
  host.addEventListener("focusout", onFocusOut);
  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("scroll", hide, true);
  tree.observe(host, { childList: true, subtree: true });

  return () => {
    hide();
    tree.disconnect();
    host.removeEventListener("pointerover", onPointerOver);
    host.removeEventListener("pointerout", onPointerOut);
    host.removeEventListener("focusin", onFocusIn);
    host.removeEventListener("focusout", onFocusOut);
    document.removeEventListener("keydown", onKeyDown);
    document.removeEventListener("pointerdown", onPointerDown, true);
    window.removeEventListener("scroll", hide, true);
    tip.remove();
  };
}
