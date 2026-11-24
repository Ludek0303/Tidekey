import { icon, iconButton } from "./icons";
import { getGraphSettings, setGraphSettings, type GraphGroup, type GraphSettings } from "./graphsettings";

// New groups take the next colour of this list, so neighbouring groups differ.
const GROUP_COLORS = ["#e5484d", "#f5a524", "#30a46c", "#0091ff", "#e93d82"];

// Floating settings of the global graph: a gear at the top right opens a panel of collapsible sections.
export function mountGraphPanel(host: HTMLElement, animate: () => void): void {
  const panel = document.createElement("div");
  panel.className = "graph-panel";
  panel.hidden = true;
  panel.setAttribute("role", "region");
  panel.setAttribute("aria-label", "Ustawienia grafu");

  const gear = iconButton("settings-2", "Ustawienia grafu", "icon-btn graph-gear");
  gear.setAttribute("aria-expanded", "false");
  gear.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    gear.setAttribute("aria-expanded", String(!panel.hidden));
  });

  panel.append(
    section("Filtry", () => [
      searchBox(),
      toggle("Tagi", "tags"),
      toggle("Tylko istniejące pliki", "existingOnly"),
      toggle("Sieroty", "orphans"),
      toggle("Pliki", "files"),
      toggle("Osoby", "people"),
      toggle("Wzmianki", "mentions"),
    ]),
    section("Grupy", () => [groupsBox()]),
    section("Wyświetlanie", () => [
      toggle("Strzałki", "arrows"),
      slider("Próg zanikania tekstu", "textFade", 0, 100, 1),
      slider("Rozmiar węzłów", "nodeSize", 0.5, 3, 0.1),
      slider("Grubość linii", "linkWidth", 0.5, 4, 0.1),
      animateButton(animate),
    ]),
    section("Siły", () => [
      slider("Siła centrowania", "centerForce", 0, 1, 0.05),
      slider("Siła odpychania", "repelForce", 20, 400, 5),
      slider("Siła połączeń", "linkForce", 0, 1, 0.05),
      slider("Odległość połączeń", "linkDistance", 20, 300, 5),
    ]),
  );
  host.append(gear, panel);
}

// Writes one field; every graph view re-reads the settings from the store.
function set<K extends keyof GraphSettings>(key: K, value: GraphSettings[K]): void {
  setGraphSettings({ ...getGraphSettings(), [key]: value });
}

// A collapsible section: its heading toggles the body, and aria-expanded tells screen readers which state it is in.
function section(title: string, build: () => HTMLElement[]): HTMLElement {
  const wrap = document.createElement("section");
  wrap.className = "graph-sec";
  const head = document.createElement("button");
  head.type = "button";
  head.className = "graph-sec-head";
  head.setAttribute("aria-expanded", "true");
  head.append(icon("chevron-down"));
  const name = document.createElement("span");
  name.textContent = title;
  head.append(name);
  const body = document.createElement("div");
  body.className = "graph-sec-body";
  body.append(...build());
  head.addEventListener("click", () => {
    body.hidden = !body.hidden;
    head.setAttribute("aria-expanded", String(!body.hidden));
  });
  wrap.append(head, body);
  return wrap;
}

function row(label: string, control: HTMLElement): HTMLElement {
  const el = document.createElement("div");
  el.className = "graph-row";
  const name = document.createElement("span");
  name.textContent = label;
  el.append(name, control);
  return el;
}

function searchBox(): HTMLElement {
  const input = document.createElement("input");
  input.type = "search";
  input.className = "graph-search";
  input.placeholder = "Filtruj po ścieżce…";
  input.value = getGraphSettings().search;
  input.setAttribute("aria-label", "Filtruj po ścieżce");
  input.addEventListener("input", () => set("search", input.value));
  return input;
}

type BoolKey = { [K in keyof GraphSettings]: GraphSettings[K] extends boolean ? K : never }[keyof GraphSettings];
type NumKey = { [K in keyof GraphSettings]: GraphSettings[K] extends number ? K : never }[keyof GraphSettings];

function toggle(label: string, key: BoolKey): HTMLElement {
  const input = document.createElement("input");
  input.type = "checkbox";
  input.className = "graph-check";
  input.checked = getGraphSettings()[key];
  input.setAttribute("aria-label", label);
  input.addEventListener("change", () => set(key, input.checked as GraphSettings[BoolKey]));
  return row(label, input);
}

function slider(label: string, key: NumKey, min: number, max: number, step: number): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "graph-slider";
  const input = document.createElement("input");
  input.type = "range";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(getGraphSettings()[key]);
  input.setAttribute("aria-label", label);
  const out = document.createElement("output");
  out.textContent = input.value;
  input.addEventListener("input", () => {
    out.textContent = input.value;
    set(key, Number(input.value) as GraphSettings[NumKey]);
  });
  wrap.append(input, out);
  return row(label, wrap);
}

function animateButton(animate: () => void): HTMLElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn graph-animate";
  btn.append(icon("rotate-ccw"), document.createTextNode("Animuj"));
  btn.addEventListener("click", animate);
  return btn;
}

// Group rows: query, colour, remove. Typing and colour changes write through without rebuilding the list, so focus stays.
function groupsBox(): HTMLElement {
  const box = document.createElement("div");
  box.className = "graph-groups";
  const list = document.createElement("div");
  const groups = (): GraphGroup[] => getGraphSettings().groups;
  const write = (i: number, patch: Partial<GraphGroup>) => {
    set("groups", groups().map((g, j) => (i === j ? { ...g, ...patch } : g)));
  };
  const render = () => {
    list.replaceChildren(
      ...groups().map((g, i) => {
        const el = document.createElement("div");
        el.className = "graph-group";
        const query = document.createElement("input");
        query.type = "text";
        query.value = g.query;
        query.placeholder = "path:Folder, tag:#x lub tekst";
        query.setAttribute("aria-label", `Zapytanie grupy ${i + 1}`);
        query.addEventListener("input", () => write(i, { query: query.value }));
        const color = document.createElement("input");
        color.type = "color";
        color.value = g.color;
        color.setAttribute("aria-label", `Kolor grupy ${i + 1}`);
        color.addEventListener("input", () => write(i, { color: color.value }));
        const remove = iconButton("x", `Usuń grupę ${i + 1}`);
        remove.addEventListener("click", () => {
          set("groups", groups().filter((_, j) => j !== i));
          render();
        });
        el.append(query, color, remove);
        return el;
      }),
    );
  };
  const add = document.createElement("button");
  add.type = "button";
  add.className = "btn graph-add";
  add.textContent = "Nowa grupa";
  add.addEventListener("click", () => {
    const color = GROUP_COLORS[groups().length % GROUP_COLORS.length];
    set("groups", [...groups(), { query: "", color }]);
    render();
  });
  render();
  box.append(list, add);
  return box;
}
