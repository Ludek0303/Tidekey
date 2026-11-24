// The zoom bar drawn inside the frame (mockup: .r-narzedzia). Labels are the app's Polish texts.
import type { Command } from "../../src/preview/protocol";

export interface ZoomBar {
  el: HTMLElement;
  setValue(text: string): void;
}

export function zoomBar(onCommand: (name: Command) => void): ZoomBar {
  const el = document.createElement("div");
  el.className = "r-narzedzia";
  el.setAttribute("role", "toolbar");
  el.setAttribute("aria-label", "Przybliżenie");

  const value = document.createElement("span");
  value.className = "wart";
  value.textContent = "100%";

  const button = (text: string, name: Command, aria?: string): HTMLButtonElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    if (aria) b.setAttribute("aria-label", aria);
    b.addEventListener("click", () => onCommand(name));
    return b;
  };

  el.append(
    button("−", "zoom-out", "Oddal"),
    value,
    button("+", "zoom-in", "Przybliż"),
    button("100%", "zoom-reset"),
    button("Dopasuj", "fit"),
  );
  return { el, setValue: (text) => { value.textContent = text; } };
}
