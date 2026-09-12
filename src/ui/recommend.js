/**
 * Suggested needs, ranked against the questionnaire.
 *
 * Each card carries the model's own sentence about *why* this person fits it.
 * A ranked list with no reasoning is indistinguishable from a random one, and
 * the reason is the part that makes someone click.
 */
import { add, clear, h, icons, joinDot } from "./dom.js";
import { recommendations } from "../lib/api.js";

export class Recommendations {
  /**
   * `heading` is off when this sits inside a dialog that already has a title —
   * otherwise the words "Suggested for you" appear twice, an inch apart.
   */
  constructor(root, { onOpenNeed, onNeedQuestionnaire, heading = true } = {}) {
    this.root = root;
    this.onOpenNeed = onOpenNeed;
    this.onNeedQuestionnaire = onNeedQuestionnaire;
    this.heading = heading;
    this.state = "idle";
  }

  /** The head row, or just the refresh control when the dialog owns the title. */
  #head() {
    return h("div", { class: `recs__head${this.heading ? "" : " recs__head--bare"}` },
      this.heading ? h("span", { class: "ml", text: "Suggested for you" }) : h("span"),
      this.state === "ready"
        ? h("button", { class: "recs__again", onclick: () => this.show({ force: true }) }, "Rank again")
        : null,
    );
  }

  async show({ force = false } = {}) {
    this.state = "loading";
    this.render();
    try {
      const res = await recommendations({ force });
      this.data = res;
      this.state = "ready";
    } catch (err) {
      this.error = String(err.message ?? err);
      this.state = "error";
    }
    this.render();
  }

  render() {
    const el = this.root;
    clear(el);

    if (this.state === "loading") {
      return add(el, [
        this.#head(),
        h("div", { class: "recs__wait" },
          h("div", { class: "recs__pulse" }),
          h("p", { class: "modal__note", text: "Reading the open needs against your answers…" }),
        ),
      ]);
    }

    if (this.state === "error") {
      return add(el, [
        this.#head(),
        h("p", { class: "modal__note", text: this.error }),
        h("button", { class: "btn btn--soft", onclick: () => this.show({ force: true }) }, "Try again"),
      ]);
    }

    const matches = this.data?.matches ?? [];

    if (!matches.length) {
      return add(el, [
        this.#head(),
        h("p", { class: "modal__note", text: this.data?.message ?? "Nothing fits your answers yet. As ministries post, this will fill in." }),
        this.data?.message?.includes("five questions") &&
          h("button", { class: "btn btn--accent", onclick: () => this.onNeedQuestionnaire?.() }, "Answer the five questions"),
      ]);
    }

    add(el, [
      this.#head(),
      ...matches.map(({ need, why, score }) =>
        h("button", { class: "recs__card", onclick: () => this.onOpenNeed?.(need) },
          h("div", { class: "recs__top" },
            h("span", { class: `dot dot--${need.urgency === "urgent" ? "urgent" : "open"}` }),
            h("span", { class: "ml", text: need.type }),
            score != null && h("span", { class: "recs__score", text: `${Math.round(score * 100)}% fit` }),
          ),
          h("b", { class: "recs__title", text: need.title }),
          h("span", { class: "recs__where", text: joinDot(need.commitment, need.remote ? "Remote OK" : null) }),
          why && h("p", { class: "recs__why" }, icons.check(), why),
        ),
      ),
      this.data?.considered
        ? h("p", { class: "recs__foot", text: `Ranked against ${this.data.considered} open need${this.data.considered === 1 ? "" : "s"}.` })
        : null,
    ]);
  }
}
