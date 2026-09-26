/** The need card in the panel rail. (The board draws rows; see board.js.) */
import { h, joinDot } from "./dom.js";
import { TYPE_BY_ID } from "../data/taxonomy.js";

export function needCard(need, { onOpen } = {}) {
  const type = TYPE_BY_ID.get(need.type)?.label ?? need.type;

  const top = h(
    "div",
    { class: "need__top" },
    h("span", { class: `dot dot--${need.urgency}` }),
    h("span", { class: "need__kind", text: type }),
    need.remote ? h("span", { class: "badge badge--remote", text: "Remote OK" }) : null,
    need.mine ? h("span", { class: "badge badge--remote", text: "Yours" }) : null,
  );

  const meta = joinDot(
    need.ministryName,
    need.city,
    need.people ? `${need.people} needed` : "",
  );

  const card = h(
    "button",
    {
      class: `need${need.taken ? " is-taken" : ""}`,
      type: "button",
      dataset: { need: need.id },
      onclick: () => onOpen?.(need),
    },
    top,
    h("div", { class: "need__title", text: need.title }),
    h("div", { class: "need__meta", text: meta }),
  );
  return card;
}

export function statTile({ label, value, sub }) {
  return h(
    "div",
    { class: "stat" },
    h("div", { class: "stat__k", text: label }),
    h("div", { class: "stat__v", text: value }),
    h("div", { class: "stat__sub", text: sub }),
  );
}

export function sectionLabel(text, note) {
  return h("div", { class: "section" }, text, note ? h("span", { text: note }) : null);
}

export function emptyState(title, body, action) {
  return h(
    "div",
    { class: "board__empty" },
    h("h3", { text: title }),
    h("p", { text: body }),
    action
      ? h(
          "button",
          { class: "btn btn--soft", style: { marginTop: "16px" }, onclick: action.onClick },
          action.label,
        )
      : null,
  );
}

