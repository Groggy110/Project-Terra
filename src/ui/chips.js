/**
 * A pick-list that does not open with everything it has.
 *
 * Twenty-four skills laid out at once is a wall: it reads as work before it
 * reads as a question, and the honest response to a wall is to skip it. So a
 * group opens with a handful and grows a handful at a time — the first screen
 * is short enough to answer, and the whole list is still one click away for
 * anyone who wants it.
 *
 * Two rules keep that from losing anything:
 *
 *   - A chosen option is never hidden. Answers restored from a saved profile
 *     are pulled to the front of the list, so reopening the questionnaire
 *     shows you what you already said rather than an apparently empty group.
 *   - The group repaints itself. Toggling a chip does not re-render the dialog
 *     around it, which is what would otherwise reset how far you had expanded
 *     and throw away the focus in the field underneath.
 */
import { add, clear, h } from "./dom.js";

const TICK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.6 8.5l2.8 2.8 5.9-6.6"/></svg>';
const CROSS = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.6 4.6l6.8 6.8M11.4 4.6l-6.8 6.8"/></svg>';
const PLUS = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.6v8.8M3.6 8h8.8"/></svg>';

/**
 * @param options   [{ id, label }]
 * @param isOn      (id) => boolean
 * @param onToggle  (id) => void   — mutate your own state; the group repaints
 * @param batch     how many to add per reveal, and how many to open with
 * @param custom    optional free text: { values(), onAdd(v), onRemove(v), placeholder }
 */
export function chipGroup({ options, isOn, onToggle, batch = 6, custom = null, single = false }) {
  const list = h("div", { class: "chips" });
  const root = h("div", { class: "chipset" }, list);
  let shown = batch;

  if (custom) root.appendChild(customField(custom, () => paint()));

  function paint() {
    clear(list);

    // Chosen first, then the rest in their own order. Sorting only the
    // selected ones to the front keeps the list otherwise stable, so a chip
    // does not move out from under the cursor when you tick the one above it.
    const picked = options.filter((o) => isOn(o.id));
    const rest = options.filter((o) => !isOn(o.id));
    const ordered = [...picked, ...rest];
    const visible = Math.max(shown, picked.length);
    const hidden = Math.max(0, ordered.length - visible);

    for (const option of ordered.slice(0, visible)) {
      const on = isOn(option.id);
      list.appendChild(
        h(
          "button",
          {
            type: "button",
            class: `chip-pick${on ? " is-on" : ""}`,
            "aria-pressed": on ? "true" : "false",
            onclick: () => {
              onToggle(option.id);
              paint();
            },
          },
          h("span", { class: "chip-pick__tick", html: TICK }),
          h("span", { class: "chip-pick__label", text: option.label }),
        ),
      );
    }

    for (const value of custom?.values() ?? []) {
      list.appendChild(
        h(
          "span",
          { class: "chip-pick is-on is-custom" },
          h("span", { class: "chip-pick__tick", html: TICK }),
          h("span", { class: "chip-pick__label", text: value }),
          h("button", {
            type: "button",
            class: "chip-pick__x",
            "aria-label": `Remove ${value}`,
            html: CROSS,
            onclick: () => {
              custom.onRemove(value);
              paint();
            },
          }),
        ),
      );
    }

    if (hidden > 0) {
      list.appendChild(
        h(
          "button",
          {
            type: "button",
            class: "chip-more",
            onclick: () => {
              shown = visible + batch;
              paint();
            },
          },
          h("span", { class: "chip-more__ico", html: PLUS }),
          hidden <= batch ? `${hidden} more` : `${batch} more`,
        ),
      );
    } else if (ordered.length > batch) {
      list.appendChild(
        h(
          "button",
          {
            type: "button",
            class: "chip-more is-less",
            onclick: () => {
              shown = batch;
              paint();
            },
          },
          "Show fewer",
        ),
      );
    }

    if (single) list.dataset.single = "";
  }

  paint();
  root.repaint = paint;
  return root;
}

/**
 * The escape hatch. A comma-separated string in a text box is a list you
 * cannot see, cannot correct one item of, and cannot tell has been understood;
 * committing each entry to a chip of its own makes all three possible.
 */
function customField({ values, onAdd, onRemove, placeholder = "Something else…" }, repaint) {
  const input = h("input", {
    class: "chip-add__input",
    type: "text",
    placeholder,
    autocomplete: "off",
    spellcheck: "false",
  });

  const commit = () => {
    const parts = input.value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!parts.length) return;
    for (const part of parts) onAdd(part);
    input.value = "";
    repaint();
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commit();
    } else if (e.key === "Backspace" && !input.value) {
      const current = values();
      if (current.length) {
        onRemove(current[current.length - 1]);
        repaint();
      }
    }
  });
  input.addEventListener("blur", commit);

  return h(
    "div",
    { class: "chip-add" },
    input,
    h("button", { type: "button", class: "chip-add__go", onclick: commit, text: "Add" }),
  );
}

export { TICK, CROSS };
