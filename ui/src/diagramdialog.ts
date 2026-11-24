//! The diagram dialog and the insertion of a diagram block. Each change is one transaction on the editor's view, so Yjs
//! and undo see it; the dialog never writes the note behind the editor's back.

import type { EditorView } from "@codemirror/view";
import { blockInsertion } from "./charts";
import { cellAt, diagramBlock, diagramOf, diagramSvg, layoutDiagram, MAX_BOXES, MAX_EDGES, type Diagram, type DiagramBox, type DiagramColor, type DiagramDirection, type DiagramEdge, type DiagramLayout, type DiagramOp } from "./diagram";
import { iconButton } from "./icons";
import { openDialog, toast } from "./widgets";

const COLORS: DiagramColor[] = ["szary", "niebieski", "zielony", "żółty", "czerwony", "fioletowy", "różowy", "pomarańczowy"];
const OPS: [DiagramOp, string][] = [
  ["->", "→ strzałka"],
  ["<-", "← strzałka wstecz"],
  ["<->", "↔ w obie strony"],
  ["--", "— linia"],
  ["..>", "⇢ przerywana"],
  ["..", "┄ przerywana linia"],
];
const DRAG_MIN = 4; // px: a shorter drag is a click

const textField = (label: string, value: string, onInput: (v: string) => void): HTMLInputElement => {
  const el = document.createElement("input");
  el.type = "text";
  el.className = "task-input";
  el.value = value;
  el.placeholder = label;
  el.setAttribute("aria-label", label);
  el.addEventListener("input", () => onInput(el.value));
  return el;
};

const select = (label: string, options: HTMLOptionElement[], value: string, onChange: (v: string) => void): HTMLSelectElement => {
  const el = document.createElement("select");
  el.className = "task-input";
  el.setAttribute("aria-label", label);
  el.append(...options);
  el.value = value;
  el.addEventListener("change", () => onChange(el.value));
  return el;
};

/** The first free id: a..z, then p27, p28… */
function nextId(boxes: DiagramBox[]): string {
  const used = new Set(boxes.map((b) => b.id));
  for (const ch of "abcdefghijklmnopqrstuvwxyz") if (!used.has(ch)) return ch;
  for (let n = 27; ; n++) if (!used.has(`p${n}`)) return `p${n}`;
}

/** Opens the diagram dialog for the block at [from, to) of the note. A read-only note shows the diagram only. */
export function openDiagramDialog(view: EditorView, from: number, to: number): void {
  const original = view.state.sliceDoc(from, to);
  const source = diagramOf(original);
  const readOnly = view.state.readOnly;
  let direction = source.direction;
  let title = source.title;
  const boxes: DiagramBox[] = source.boxes.map((b) => ({ ...b }));
  const edges: DiagramEdge[] = source.edges.map((e) => ({ ...e }));
  // the diagram as it would be saved: an empty label is the id
  const current = (): Diagram => ({
    direction,
    title: title.trim(),
    skipped: 0,
    boxes: boxes.map((b) => ({ ...b, label: b.label.trim() || b.id })),
    edges: edges.map((e) => ({ ...e })),
  });
  const preview = document.createElement("div");
  preview.className = "dg-frame";
  const boxList = document.createElement("div");
  boxList.className = "dg-rows";
  const edgeList = document.createElement("div");
  edgeList.className = "dg-rows";

  // The preview: a box dragged and dropped takes a grid cell; every box then keeps the cell the layout gave it.
  const drop = (id: string, lay: DiagramLayout, dx: number, dy: number): void => {
    const placed = lay.boxes.find((p) => p.box.id === id);
    if (!placed) return;
    const target = cellAt(lay, placed.x + placed.w / 2 + dx, placed.y + placed.h / 2 + dy);
    for (const p of lay.boxes) boxes.find((b) => b.id === p.box.id)!.pos = { col: p.col, row: p.row };
    const mover = boxes.find((b) => b.id === id)!;
    const home = mover.pos!;
    const occupant = boxes.find((b) => b !== mover && b.pos!.col === target.col && b.pos!.row === target.row);
    if (occupant) occupant.pos = home; // the box there takes the dragged box's old cell
    mover.pos = target;
    redraw();
  };
  const bindDrag = (svg: SVGSVGElement, lay: DiagramLayout): void => {
    let drag: { id: string; g: SVGGElement; x: number; y: number; k: number; dx: number; dy: number } | null = null;
    svg.addEventListener("pointerdown", (e) => {
      const g = e.target instanceof Element ? e.target.closest<SVGGElement>(".dg-node") : null;
      if (!g || !e.isPrimary || e.button !== 0) return;
      // view units per screen pixel, so the drag follows the pointer at any width
      const screen = svg.getBoundingClientRect().width;
      drag = { id: g.dataset.id ?? "", g, x: e.clientX, y: e.clientY, k: screen ? svg.viewBox.baseVal.width / screen : 1, dx: 0, dy: 0 };
      svg.setPointerCapture?.(e.pointerId);
    });
    svg.addEventListener("pointermove", (e) => {
      if (!drag) return;
      drag.dx = (e.clientX - drag.x) * drag.k;
      drag.dy = (e.clientY - drag.y) * drag.k;
      drag.g.setAttribute("transform", `translate(${drag.dx} ${drag.dy})`);
    });
    const finish = (): void => {
      const d = drag;
      drag = null;
      if (!d) return;
      d.g.removeAttribute("transform");
      if (Math.hypot(d.dx, d.dy) >= DRAG_MIN) drop(d.id, lay, d.dx, d.dy);
    };
    svg.addEventListener("pointerup", finish);
    svg.addEventListener("pointercancel", finish);
  };
  const redraw = (): void => {
    const d = current();
    const svg = diagramSvg(d);
    if (!readOnly && d.boxes.length) {
      svg.classList.add("dg-editable");
      bindDrag(svg, layoutDiagram(d));
    }
    preview.replaceChildren(svg);
  };

  openDialog({
    label: readOnly ? "Schemat" : "Edycja schematu",
    className: "diagram-dialog",
    render(box, close) {
      // the label of each box, in the connection selects too
      const refreshOptions = (): void => {
        edgeList.querySelectorAll<HTMLOptionElement>("option[data-box]").forEach((o) => {
          const b = boxes.find((x) => x.id === o.value);
          if (b) o.textContent = b.label.trim() || b.id;
        });
      };
      const boxOption = (b: DiagramBox): HTMLOptionElement => {
        const o = new Option(b.label.trim() || b.id, b.id);
        o.dataset.box = "";
        return o;
      };
      const paintBoxes = (): void => {
        boxList.replaceChildren(...boxes.map(boxRow));
        addBox.disabled = boxes.length >= MAX_BOXES;
      };
      const paintEdges = (): void => {
        edgeList.replaceChildren(...edges.map(edgeRow));
        addEdge.disabled = boxes.length === 0 || edges.length >= MAX_EDGES;
      };
      const removeBox = (b: DiagramBox): void => {
        boxes.splice(boxes.indexOf(b), 1);
        for (let k = edges.length - 1; k >= 0; k--) if (edges[k].from === b.id || edges[k].to === b.id) edges.splice(k, 1);
        paintBoxes();
        paintEdges();
        redraw();
      };

      const boxRow = (b: DiagramBox): HTMLElement => {
        const row = document.createElement("div");
        row.className = "dg-row dg-box-row";
        const label = textField("Etykieta prostokąta", b.label, (v) => {
          b.label = v;
          redraw();
          refreshOptions();
        });
        const swatches = document.createElement("div");
        swatches.className = "dg-swatches";
        swatches.setAttribute("role", "group");
        swatches.setAttribute("aria-label", "Kolor prostokąta");
        const swatch = (c: DiagramColor): HTMLButtonElement => {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = `dg-swatch dg-c-${c}`;
          btn.title = c;
          btn.setAttribute("aria-label", c);
          btn.setAttribute("aria-pressed", String(b.color === c));
          btn.addEventListener("click", () => {
            b.color = c;
            swatches.querySelectorAll("button").forEach((s) => s.setAttribute("aria-pressed", String(s === btn)));
            redraw();
          });
          return btn;
        };
        swatches.append(...COLORS.map(swatch));
        const remove = iconButton("x", "Usuń prostokąt", "icon-btn");
        remove.addEventListener("click", () => removeBox(b));
        row.append(label, swatches, remove);
        return row;
      };
      const edgeRow = (e: DiagramEdge): HTMLElement => {
        const row = document.createElement("div");
        row.className = "dg-row dg-edge-row";
        const from = select("Od", boxes.map(boxOption), e.from, (v) => {
          e.from = v;
          redraw();
        });
        const op = select("Rodzaj połączenia", OPS.map(([o, name]) => new Option(name, o)), e.op, (v) => {
          e.op = v as DiagramOp;
          redraw();
        });
        const to = select("Do", boxes.map(boxOption), e.to, (v) => {
          e.to = v;
          redraw();
        });
        const label = textField("Etykieta połączenia", e.label, (v) => {
          e.label = v;
          redraw();
        });
        const remove = iconButton("x", "Usuń połączenie", "icon-btn");
        remove.addEventListener("click", () => {
          edges.splice(edges.indexOf(e), 1);
          paintEdges();
          redraw();
        });
        row.append(from, op, to, label, remove);
        return row;
      };

      const addBox = document.createElement("button");
      addBox.type = "button";
      addBox.className = "btn";
      addBox.textContent = "+ Dodaj prostokąt";
      addBox.addEventListener("click", () => {
        if (boxes.length >= MAX_BOXES) return;
        const id = nextId(boxes);
        boxes.push({ id, label: id, color: "szary", pos: null });
        paintBoxes();
        paintEdges();
        redraw();
        boxList.lastElementChild?.querySelector("input")?.focus();
      });
      const addEdge = document.createElement("button");
      addEdge.type = "button";
      addEdge.className = "btn";
      addEdge.textContent = "+ Dodaj połączenie";
      addEdge.addEventListener("click", () => {
        if (!boxes.length || edges.length >= MAX_EDGES) return;
        edges.push({ from: boxes[0].id, to: (boxes[1] ?? boxes[0]).id, op: "->", label: "" });
        paintEdges();
        redraw();
        edgeList.lastElementChild?.querySelector("select")?.focus();
      });

      const sectionOf = (heading: string, content: HTMLElement[]): HTMLElement => {
        const section = document.createElement("section");
        section.className = "dg-section";
        const h = document.createElement("h3");
        h.className = "dg-heading";
        h.textContent = heading;
        section.append(h, ...content);
        return section;
      };

      const dirs = document.createElement("div");
      dirs.className = "dg-dirs";
      dirs.setAttribute("role", "group");
      dirs.setAttribute("aria-label", "Kierunek");
      const dirButtons: [DiagramDirection, HTMLButtonElement][] = [];
      for (const [kind, name] of [["right", "W prawo"], ["down", "W dół"]] as const) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "btn dg-dir";
        btn.textContent = name;
        btn.setAttribute("aria-pressed", String(kind === direction));
        btn.addEventListener("click", () => {
          direction = kind;
          dirButtons.forEach(([k, b]) => b.setAttribute("aria-pressed", String(k === direction)));
          redraw();
        });
        dirButtons.push([kind, btn]);
      }
      dirs.append(...dirButtons.map(([, b]) => b));

      const titleInput = textField("Tytuł", title, (v) => {
        title = v;
        redraw();
      });
      const titleLabel = document.createElement("label");
      titleLabel.className = "dg-field";
      titleLabel.append("Tytuł", titleInput);

      const autoBtn = document.createElement("button");
      autoBtn.type = "button";
      autoBtn.className = "btn";
      autoBtn.textContent = "Układ automatyczny";
      autoBtn.addEventListener("click", () => {
        boxes.forEach((b) => (b.pos = null));
        redraw();
      });

      const foot = document.createElement("div");
      foot.className = "dg-foot";
      const actions = document.createElement("div");
      actions.className = "modal-actions";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "btn";
      cancel.textContent = readOnly ? "Zamknij" : "Anuluj";
      cancel.addEventListener("click", close);
      actions.append(cancel);
      if (!readOnly) {
        const save = document.createElement("button");
        save.type = "button";
        save.className = "btn btn-primary";
        save.textContent = "Zapisz";
        save.addEventListener("click", () => {
          // the block must still be where it was opened, with the same text, or the save would cut other text
          if (view.state.sliceDoc(from, to) !== original) return toast("Schemat zmienił się w notatce. Spróbuj ponownie.", true);
          view.dispatch({ changes: { from, to, insert: diagramBlock(current()) }, userEvent: "input" });
          close();
          view.focus();
        });
        actions.append(save);
        foot.append(autoBtn);
      }
      if (source.skipped > 0) {
        const note = document.createElement("p");
        note.className = "dg-note";
        note.textContent = `Pominięto ${source.skipped} linii, których nie da się odczytać.`;
        foot.append(note);
      }
      foot.append(actions);

      if (readOnly) box.append(preview, foot);
      else {
        paintBoxes();
        paintEdges();
        box.append(
          dirs,
          preview,
          titleLabel,
          sectionOf("Prostokąty", [boxList, addBox]),
          sectionOf("Połączenia", [edgeList, addEdge]),
          foot,
        );
      }
      redraw();
    },
  });
}

/** Puts a diagram block at `at` (on lines of its own, see blockInsertion), puts the caret after it and opens its dialog. */
export function insertDiagramBlock(view: EditorView, at: number, diagram: Diagram): void {
  const block = diagramBlock(diagram);
  const { insert, start } = blockInsertion(view.state.doc.toString(), at, block);
  view.dispatch({ changes: { from: at, insert }, selection: { anchor: start + block.length }, userEvent: "input", scrollIntoView: true });
  openDiagramDialog(view, start, start + block.length);
}
