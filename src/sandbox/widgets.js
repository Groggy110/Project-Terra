/**
 * The control vocabulary the panels are assembled from. Every widget is a row
 * with a label on the left and an editor on the right, and every one of them
 * reports through a single `onChange(value)` - so a panel is a list of these
 * and nothing more.
 */
import { h } from "../ui/dom.js";
import { EASING_GROUPS, EASING_NAMES, resolveEasing, sampleCurve, isBezierSpec } from "./anim.js";
import { formatColor, parseColor, toHex } from "./tokens.js";

const round = (n, step) => {
  const dp = String(step).includes(".") ? String(step).split(".")[1].length : 0;
  return Number(Number(n).toFixed(dp));
};

export function section(title, { open = true, right = null, id = null } = {}) {
  const body = h("div", { class: "sbx-sec__body" });
  const caret = h("span", { class: "sbx-caret", html: "&rsaquo;" });
  const head = h(
    "button",
    { class: "sbx-sec__head", type: "button" },
    caret,
    h("span", { class: "sbx-sec__title", text: title }),
  );
  const el = h("section", { class: `sbx-sec${open ? " is-open" : ""}`, dataset: id ? { sec: id } : {} }, head, right, body);
  head.addEventListener("click", () => {
    el.classList.toggle("is-open");
    el.dispatchEvent(new CustomEvent("sbx:toggle", { bubbles: true, detail: { open: el.classList.contains("is-open"), id } }));
  });
  return { el, body, head };
}

export function row(label, control, { hint = null, wide = false } = {}) {
  return h(
    "label",
    { class: `sbx-row${wide ? " sbx-row--wide" : ""}` },
    h("span", { class: "sbx-row__label", title: hint || label }, label),
    h("span", { class: "sbx-row__ctl" }, control),
  );
}

/* ------------------------------------------------------------- primitives */

export function slider({ value, min, max, step = 1, unit = "", onChange }) {
  const range = h("input", { class: "sbx-range", type: "range", min, max, step, value });
  const field = h("input", { class: "sbx-num", type: "number", min, max, step, value });
  const suffix = unit ? h("span", { class: "sbx-unit", text: unit }) : null;

  const push = (v, from) => {
    const n = round(Math.min(Math.max(Number(v), min), max), step);
    if (from !== "range") range.value = n;
    if (from !== "field") field.value = n;
    onChange(n);
  };
  range.addEventListener("input", () => push(range.value, "range"));
  field.addEventListener("change", () => push(field.value, "field"));

  const el = h("span", { class: "sbx-slider" }, range, field, suffix);
  el.set = (v) => {
    range.value = v;
    field.value = v;
  };
  return el;
}

export function numberField({ value, min = -Infinity, max = Infinity, step = 1, unit = "", onChange }) {
  const field = h("input", { class: "sbx-num sbx-num--wide", type: "number", step, value });
  field.addEventListener("change", () => {
    const n = round(Math.min(Math.max(Number(field.value) || 0, min), max), step);
    field.value = n;
    onChange(n);
  });
  const el = h("span", { class: "sbx-slider" }, field, unit ? h("span", { class: "sbx-unit", text: unit }) : null);
  el.set = (v) => (field.value = v);
  return el;
}

export function textField({ value, onChange, mono = true, placeholder = "" }) {
  const field = h("input", {
    class: `sbx-text${mono ? " sbx-text--mono" : ""}`,
    type: "text",
    value: value ?? "",
    placeholder,
    spellcheck: "false",
  });
  const commit = () => onChange(field.value);
  field.addEventListener("change", commit);
  field.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    }
  });
  const el = h("span", { class: "sbx-fill" }, field);
  el.set = (v) => (field.value = v ?? "");
  return el;
}

export function toggle({ value, onChange, label = "" }) {
  const box = h("input", { class: "sbx-check", type: "checkbox", checked: !!value });
  box.addEventListener("change", () => onChange(box.checked));
  const el = h("span", { class: "sbx-toggle" }, box, label ? h("span", { text: label }) : null);
  el.set = (v) => (box.checked = !!v);
  return el;
}

export function select({ value, options, onChange }) {
  const sel = h("select", { class: "sbx-select" });
  for (const opt of options) {
    if (Array.isArray(opt.options)) {
      const group = h("optgroup", { label: opt.label });
      for (const o of opt.options) group.appendChild(h("option", { value: o.value, text: o.label }));
      sel.appendChild(group);
    } else {
      sel.appendChild(h("option", { value: opt.value, text: opt.label }));
    }
  }
  sel.value = value;
  sel.addEventListener("change", () => onChange(sel.value));
  const el = h("span", { class: "sbx-fill" }, sel);
  el.set = (v) => (sel.value = v);
  return el;
}

export function button(label, onClick, { kind = "", title = "" } = {}) {
  return h("button", { class: `sbx-btn ${kind}`.trim(), type: "button", title: title || label, onclick: onClick }, label);
}

/* ------------------------------------------------------------------ colour */

/**
 * A swatch, a hex field and - only when the value actually carries one - an
 * alpha slider. Tokens like --line are rgba() by design and editing them as
 * opaque hex would quietly destroy them.
 */
export function colorField({ value, onChange }) {
  const parsed = parseColor(value) ?? { r: 0, g: 0, b: 0, a: 1 };
  const state = { ...parsed };

  const swatch = h("input", { class: "sbx-swatch", type: "color", value: toHex(state) });
  const text = h("input", { class: "sbx-text sbx-text--mono sbx-text--color", type: "text", value, spellcheck: "false" });
  const alpha = h("input", {
    class: "sbx-range sbx-range--alpha",
    type: "range",
    min: 0,
    max: 1,
    step: 0.01,
    value: state.a,
    title: "Opacity",
  });

  const emit = () => {
    const out = formatColor(state);
    text.value = out;
    onChange(out);
  };

  swatch.addEventListener("input", () => {
    Object.assign(state, parseColor(swatch.value));
    state.a = Number(alpha.value);
    emit();
  });
  alpha.addEventListener("input", () => {
    state.a = Number(alpha.value);
    emit();
  });
  text.addEventListener("change", () => {
    const next = parseColor(text.value);
    if (next) {
      Object.assign(state, next);
      swatch.value = toHex(state);
      alpha.value = state.a;
      emit();
    } else {
      // Not a colour we can take apart (color-mix, a var reference) - pass it
      // through verbatim rather than refusing the edit.
      onChange(text.value);
    }
  });

  const el = h("span", { class: "sbx-color" }, swatch, text, alpha);
  el.set = (v) => {
    const next = parseColor(v);
    text.value = v;
    if (next) {
      Object.assign(state, next);
      swatch.value = toHex(state);
      alpha.value = state.a;
    }
  };
  return el;
}

/* ------------------------------------------------------------------ easing */

const CURVE_W = 46;
const CURVE_H = 26;

/** The little inline plot beside an easing picker. */
export function curvePreview(spec) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  el.setAttribute("class", "sbx-curve");
  el.setAttribute("viewBox", `0 0 ${CURVE_W} ${CURVE_H}`);
  el.setAttribute("aria-hidden", "true");
  el.draw = (next) => {
    const fn = resolveEasing(next);
    const pad = 3;
    const d = sampleCurve(fn, 40)
      .map(([x, y], i) => {
        const px = pad + x * (CURVE_W - pad * 2);
        const py = CURVE_H - pad - y * (CURVE_H - pad * 2);
        return `${i ? "L" : "M"}${px.toFixed(2)} ${py.toFixed(2)}`;
      })
      .join("");
    el.innerHTML = `<path class="sbx-curve__grid" d="M${pad} ${CURVE_H - pad}H${CURVE_W - pad}"/><path class="sbx-curve__line" d="${d}"/>`;
  };
  el.draw(spec);
  return el;
}

/**
 * Named curves plus a free-text escape hatch, because "whichever is faster"
 * cuts both ways: the list covers the usual cases, and `cubic-bezier(...)`
 * covers the one you pulled off a motion spec.
 */
export function easingField({ value, onChange }) {
  const custom = isBezierSpec(value);
  const options = [
    ...EASING_GROUPS.map(([label, names]) => ({
      label,
      options: names.map((n) => ({ value: n, label: n })),
    })),
    { label: "Custom", options: [{ value: "__custom", label: "cubic-bezier()…" }] },
  ];

  const preview = curvePreview(value);
  const text = h("input", {
    class: "sbx-text sbx-text--mono",
    type: "text",
    value: custom ? value : "cubic-bezier(0.22, 0.61, 0.24, 1)",
    hidden: !custom,
    spellcheck: "false",
  });

  const picker = select({
    value: custom ? "__custom" : EASING_NAMES.includes(value) ? value : "linear",
    options,
    onChange: (v) => {
      if (v === "__custom") {
        text.hidden = false;
        preview.draw(text.value);
        onChange(text.value);
      } else {
        text.hidden = true;
        preview.draw(v);
        onChange(v);
      }
    },
  });

  const commit = () => {
    preview.draw(text.value);
    onChange(text.value);
  };
  text.addEventListener("change", commit);
  text.addEventListener("keydown", (e) => e.key === "Enter" && commit());

  const el = h("span", { class: "sbx-easing" }, preview, picker, text);
  el.set = (v) => {
    const isCustom = isBezierSpec(v);
    picker.set(isCustom ? "__custom" : v);
    text.hidden = !isCustom;
    if (isCustom) text.value = v;
    preview.draw(v);
  };
  return el;
}

/* -------------------------------------------------------------- utilities */

export function note(text) {
  return h("p", { class: "sbx-note", text });
}

export function buttonRow(...buttons) {
  return h("div", { class: "sbx-btnrow" }, ...buttons);
}
