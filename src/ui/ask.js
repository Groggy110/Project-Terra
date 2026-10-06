/**
 * Ask Terra — the search bar as a conversation.
 *
 * Enter in the find bar sends the question here instead of filtering as you
 * type. The answer arrives in a glass panel down the left of the map (a sheet
 * on a phone): a sentence or two, then the needs that fit as cards. A card
 * flies the globe to its ministry and opens the need; the matching pins stay
 * lit while the rest of the network dims. Follow-ups go in the composer at the
 * foot and are answered with the conversation so far in hand.
 *
 * When the guide cannot be reached — no backend, no key, a network blip — the
 * same question is answered by the keyword search instead, so the panel always
 * has something true to show.
 */
import { add, clear, h, icons, svg } from "./dom.js";
import { emptyQuery } from "../data/network.js";
import { pullToClose } from "./swipe.js";

const PHONE = window.matchMedia("(max-width: 720px)");

const spark = () =>
  svg("0 0 16 16", '<path d="M8 1.8c.4 2.9 1.4 4.6 4.8 6.2-3.4 1.6-4.4 3.3-4.8 6.2-.4-2.9-1.4-4.6-4.8-6.2C6.6 6.4 7.6 4.7 8 1.8z" class="ico__fill"/>', "ask__spark");
const send = () => svg("0 0 16 16", '<path d="M8 12.8V3.4M4.2 7.2 8 3.4l3.8 3.8"/>');

const EXAMPLES = [
  "I have a free afternoon — what could I do?",
  "I want to serve in the Philippines",
  "Anything for a nurse?",
  "Urgent needs I can do from home",
];

export class AskPanel {
  constructor({ net, ask, onOpenNeed, onResults, onToggle }) {
    this.net = net;
    this.ask = ask;
    this.onOpenNeed = onOpenNeed;
    this.onResults = onResults;
    this.onToggle = onToggle;
    this.turns = [];
    this.open = false;
    this.busy = false;
    this.active = null;

    this.thread = h("div", { class: "ask__thread scroll" });
    this.input = h("input", {
      class: "ask__input",
      type: "text",
      placeholder: "Ask a follow-up…",
      "aria-label": "Ask Terra a follow-up",
      enterkeyhint: "send",
      autocomplete: "off",
    });
    this.sendBtn = h("button", { class: "ask__send", type: "submit", "aria-label": "Send" }, send());
    const form = h("form", { class: "ask__composer" }, this.input, this.sendBtn);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const q = this.input.value.trim();
      if (!q || this.busy) return;
      this.input.value = "";
      this.submit(q);
    });

    this.head = h(
      "div",
      { class: "ask__head" },
      h("button", { class: "ask__title", type: "button", onclick: () => this.root.classList.remove("is-min") },
        spark(),
        h("span", { text: "Ask Terra" }),
        h("span", { class: "ask__count" }),
      ),
      h("button", { class: "ask__new", type: "button", onclick: () => this.reset() }, "New"),
      h("button", { class: "ask__x", type: "button", "aria-label": "Close", onclick: () => this.close() }, icons.close()),
    );

    this.root = h(
      "aside",
      { class: "ask", "aria-label": "Ask Terra", hidden: true },
      this.head,
      this.thread,
      form,
    );
    document.body.appendChild(this.root);
    pullToClose(this.root, { onClose: () => this.close() });
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.open && !document.querySelector(".modal")) this.close();
    });
  }

  /** A question from the find bar or the composer. */
  async submit(question) {
    this.#show();
    this.root.classList.remove("is-min");
    const history = this.turns.filter((t) => !t.pending).map((t) => ({ role: t.role, text: t.text }));
    this.turns.push({ role: "user", text: question });
    const answer = { role: "assistant", text: "", picks: [], pending: true };
    this.turns.push(answer);
    this.busy = true;
    this.render();

    const needs = this.net.needs;
    let result = null;
    try {
      result = this.ask ? await this.ask({ question, history, needs }) : null;
    } catch {
      result = null;
    }

    if (result) {
      const byId = new Map(needs.map((n) => [n.id, n]));
      answer.picks = result.picks.map((p) => ({ need: byId.get(p.id), why: p.why })).filter((p) => p.need);
      answer.text = result.reply;
    } else {
      answer.picks = this.net
        .select({ ...emptyQuery(), text: question })
        .slice(0, 8)
        .map((need) => ({ need, why: "" }));
      answer.text = answer.picks.length
        ? `Here are the closest matches for “${question}”.`
        : `Nothing on the map matches “${question}” yet. Try a skill, a cause or a country.`;
      answer.fallback = true;
    }
    answer.pending = false;
    this.busy = false;
    this.active = null;
    this.render();
    this.onResults?.(answer.picks.map((p) => p.need));
  }

  reset() {
    this.turns = [];
    this.active = null;
    this.render();
    this.onResults?.([]);
    this.input.focus({ preventScroll: true });
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.root.classList.remove("is-in");
    document.body.classList.remove("ask-open");
    this.onResults?.(null);
    this.onToggle?.(false);
    setTimeout(() => {
      if (!this.open) this.root.hidden = true;
    }, 320);
  }

  #show() {
    if (this.open) return;
    this.open = true;
    this.root.hidden = false;
    document.body.classList.add("ask-open");
    requestAnimationFrame(() => this.root.classList.add("is-in"));
    this.onToggle?.(true);
  }

  #pick(p, card) {
    this.active = p.need.id;
    for (const c of this.thread.querySelectorAll(".ask__card")) c.classList.toggle("is-active", c === card);
    // On a phone the sheet steps down to its header so the globe can be seen
    // flying there; the header brings it back.
    if (PHONE.matches) this.root.classList.add("is-min");
    this.onOpenNeed?.(p.need);
  }

  #card(p) {
    const n = p.need;
    const card = h(
      "button",
      { class: `ask__card${this.active === n.id ? " is-active" : ""}`, type: "button" },
      h("span", { class: "ask__card-top" },
        h("span", { class: `dot dot--${n.urgency}` }),
        h("span", { class: "ml", text: n.type }),
        n.remote ? h("span", { class: "ask__tag", text: "Remote" }) : null,
        h("span", { class: "ask__fly" }, "Fly there", icons.arrow()),
      ),
      h("b", { class: "ask__card-title", text: n.title }),
      h("span", { class: "ask__card-where" },
        icons.pin(),
        `${n.ministryName} · ${[n.city, n.country].filter(Boolean).join(", ")}`,
      ),
      p.why ? h("span", { class: "ask__why", text: p.why }) : null,
      n.commitment ? h("span", { class: "ask__commit", text: n.commitment }) : null,
    );
    card.addEventListener("click", () => this.#pick(p, card));
    return card;
  }

  render() {
    clear(this.thread);
    const last = [...this.turns].reverse().find((t) => t.role === "assistant" && !t.pending);
    this.head.querySelector(".ask__count").textContent = last?.picks.length
      ? `${last.picks.length} result${last.picks.length === 1 ? "" : "s"}`
      : "";

    if (!this.turns.length) {
      add(this.thread, [
        h("p", { class: "ask__hello", text: "Tell me what you'd like to do — your time, your skills, or where in the world — and I'll find the needs that fit." }),
        h("div", { class: "ask__examples" },
          ...EXAMPLES.map((q) => h("button", { class: "ask__example", type: "button", onclick: () => this.submit(q) }, q)),
        ),
      ]);
    }

    for (const t of this.turns) {
      if (t.role === "user") {
        this.thread.appendChild(h("div", { class: "ask__q", text: t.text }));
        continue;
      }
      if (t.pending) {
        this.thread.appendChild(
          h("div", { class: "ask__a ask__a--wait", "aria-live": "polite" },
            h("span", { class: "ask__dots" }, h("i"), h("i"), h("i")),
            h("span", { text: "Looking across the network…" }),
          ),
        );
        continue;
      }
      this.thread.appendChild(
        h("div", { class: "ask__a", "aria-live": "polite" },
          h("p", { class: "ask__reply", text: t.text }),
          t.picks.length ? h("div", { class: "ask__cards" }, ...t.picks.map((p) => this.#card(p))) : null,
        ),
      );
    }

    this.sendBtn.disabled = this.busy;
    requestAnimationFrame(() => {
      // The newest exchange in view: the start of the answer, not its last card.
      const q = this.thread.querySelectorAll(".ask__q");
      const anchor = q[q.length - 1];
      if (anchor) this.thread.scrollTop = anchor.offsetTop - 8;
    });
  }
}
