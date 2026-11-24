//! The chart dialog and the insertion of a chart block. Each change is one transaction on the editor's view, so Yjs and
//! undo see it; the dialog never writes the note behind the editor's back.

import type { EditorView } from "@codemirror/view";
import { blockInsertion, chartBlock, chartBody, chartSvg, formatValue, linkedChart, MAX_POINTS, numericHeaders, parseChart, parseValue, tableAbove, type Chart, type ChartType, type ResolvedChart } from "./charts";
import { icon, iconButton } from "./icons";
import { openDialog, toast } from "./widgets";

interface Row { label: string; value: string }

const TYPES: [ChartType, string, "chart-column" | "chart-pie"][] = [
  ["bar", "Słupkowy", "chart-column"],
  ["pie", "Kołowy", "chart-pie"],
];

const field = (label: string, value: string, onInput: (v: string) => void, mode?: string): HTMLInputElement => {
  const el = document.createElement("input");
  el.type = "text";
  el.className = "task-input";
  el.value = value;
  el.placeholder = label;
  el.setAttribute("aria-label", label);
  if (mode) el.inputMode = mode;
  el.addEventListener("input", () => onInput(el.value));
  return el;
};

/** Opens the chart dialog for the chart block at [from, to) of the note. A read-only note shows the chart only. */
export function openChartDialog(view: EditorView, from: number, to: number): void {
  const original = view.state.sliceDoc(from, to);
  const source = parseChart(chartBody(original));
  const readOnly = view.state.readOnly;
  // the table above the block, as it is when the dialog opens: a linked chart reads it
  const table = tableAbove(view.state.doc.toString(), from);
  let type = source.type;
  let title = source.title;
  let linked = source.source !== null;
  let column = source.source?.column ?? null;
  const rows: Row[] = source.points.map((p) => ({ label: p.label, value: formatValue(p.value) }));
  const preview = document.createElement("div");
  preview.className = "chart-box";
  // Rows that do not read as a number or have no label are left out of the chart, as they are left out of the note.
  const current = (): Chart => ({
    type,
    title: title.trim(),
    skipped: 0,
    source: linked ? { column } : null,
    points: linked
      ? []
      : rows.flatMap((r) => {
          const value = parseValue(r.value);
          const label = r.label.trim();
          return value !== null && label ? [{ label, value }] : [];
        }),
  });
  const shown = (): ResolvedChart => (linked ? linkedChart(current(), table) : { chart: current(), error: null });
  const redraw = (): void => {
    const { chart, error } = shown();
    preview.replaceChildren(chartSvg(chart, error));
  };

  openDialog({
    label: readOnly ? "Wykres" : "Edycja wykresu",
    className: "chart-dialog",
    render(box, close) {
      const kinds = document.createElement("div");
      kinds.className = "chart-types";
      kinds.setAttribute("role", "group");
      kinds.setAttribute("aria-label", "Typ wykresu");
      const kindButtons = TYPES.map(([kind, name, ic]) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "btn chart-type";
        btn.setAttribute("aria-pressed", String(kind === type));
        btn.append(icon(ic), ` ${name}`);
        btn.addEventListener("click", () => {
          type = kind;
          kindButtons.forEach((b, i) => b.setAttribute("aria-pressed", String(TYPES[i][0] === type)));
          redraw();
        });
        return btn;
      });
      kinds.append(...kindButtons);

      // the values of an own chart, or the table link of a linked one: the box is repainted when the mode changes
      const values = document.createElement("div");
      values.className = "chart-rows";
      const list = document.createElement("div");
      list.className = "chart-rows";
      const add = document.createElement("button");
      add.type = "button";
      add.className = "btn";
      add.textContent = "+ Dodaj wartość";
      add.addEventListener("click", () => {
        rows.push({ label: "", value: "" });
        paintRows();
        redraw();
        list.lastElementChild?.querySelector("input")?.focus();
      });
      const rowEl = (row: Row, i: number): HTMLElement => {
        const el = document.createElement("div");
        el.className = "chart-row";
        const label = field("Etykieta", row.label, (v) => {
          row.label = v;
          redraw();
        });
        const value = field(
          "Wartość",
          row.value,
          (v) => {
            row.value = v;
            value.toggleAttribute("aria-invalid", v.trim() !== "" && parseValue(v) === null);
            redraw();
          },
          "decimal",
        );
        const remove = iconButton("x", "Usuń wartość", "icon-btn chart-row-remove");
        remove.addEventListener("click", () => {
          rows.splice(i, 1);
          paintRows();
          redraw();
        });
        el.append(label, value, remove);
        return el;
      };
      const paintRows = (): void => {
        list.replaceChildren(...rows.map(rowEl));
        add.disabled = rows.length >= MAX_POINTS;
      };

      const titleInput = field("Tytuł", title, (v) => {
        title = v;
        redraw();
      });
      const titleLabel = document.createElement("label");
      titleLabel.className = "chart-field";
      titleLabel.append("Tytuł", titleInput);

      const linkNote = document.createElement("p");
      linkNote.className = "chart-note";
      linkNote.textContent = "Dane z tabeli nad wykresem. Wykres zmienia się razem z tabelą.";
      const pick = document.createElement("select");
      pick.className = "task-input";
      pick.addEventListener("change", () => {
        column = pick.value || null;
        redraw();
      });
      const pickLabel = document.createElement("label");
      pickLabel.className = "chart-field";
      pickLabel.append("Kolumna z wartościami", pick);
      const paintPick = (): void => {
        const names = numericHeaders(table ?? []);
        if (column && !names.includes(column)) names.push(column); // a name the table lacks stays visible, with its error
        pick.replaceChildren(new Option("Pierwsza kolumna z liczbami", ""), ...names.map((n) => new Option(n, n)));
        pick.value = column ?? "";
      };
      const detach = document.createElement("button");
      detach.type = "button";
      detach.className = "btn";
      detach.textContent = "Odłącz od tabeli";
      detach.addEventListener("click", () => {
        // the chart's points become its own values; they are saved only on "Zapisz"
        const resolved = linkedChart(current(), table);
        linked = false;
        rows.splice(0, rows.length, ...resolved.chart.points.map((p) => ({ label: p.label, value: formatValue(p.value) })));
        if (!title.trim()) {
          title = resolved.chart.title;
          titleInput.value = title;
        }
        paintValues();
        redraw();
      });
      const connect = document.createElement("button");
      connect.type = "button";
      connect.className = "btn";
      connect.textContent = "Połącz z tabelą nad wykresem";
      connect.addEventListener("click", () => {
        linked = true;
        column = null;
        paintValues();
        redraw();
      });
      const paintValues = (): void => {
        if (linked) {
          paintPick();
          values.replaceChildren(linkNote, pickLabel, detach);
        } else {
          paintRows();
          values.replaceChildren(list, add, ...(table ? [connect] : []));
        }
      };

      const foot = document.createElement("div");
      foot.className = "chart-foot";
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
          if (view.state.sliceDoc(from, to) !== original) return toast("Wykres zmienił się w notatce. Spróbuj ponownie.", true);
          view.dispatch({ changes: { from, to, insert: chartBlock(current()) }, userEvent: "input" });
          close();
          view.focus();
        });
        actions.append(save);
      }
      if (source.skipped > 0) {
        const note = document.createElement("p");
        note.className = "chart-note";
        note.textContent = `Pominięto ${source.skipped} wierszy, których nie da się odczytać.`;
        foot.append(note);
      }
      foot.append(actions);

      if (readOnly) box.append(preview, foot);
      else {
        paintValues();
        box.append(kinds, preview, titleLabel, values, foot);
      }
      redraw();
    },
  });
}

/** Puts a chart block at `at` (on lines of its own, see blockInsertion), puts the caret after it and opens its dialog. */
export function insertChartBlock(view: EditorView, at: number, chart: Chart): void {
  const block = chartBlock(chart);
  const { insert, start } = blockInsertion(view.state.doc.toString(), at, block);
  view.dispatch({ changes: { from: at, insert }, selection: { anchor: start + block.length }, userEvent: "input", scrollIntoView: true });
  openChartDialog(view, start, start + block.length);
}
