/**
 * Ask Terra — the search bar as a conversation.
 *
 * Enter in the find bar sends the question here instead of filtering as you
 * type. The answer arrives in one window of frosted glass in the middle of
 * the map (the whole screen on a phone), the planet blurred but turning
 * behind it: a sentence or two, then the needs that fit as cards. A card
 * flies the globe to its ministry and opens the need right there in the
 * conversation, under its answer — no panel or popup beside it — where it
 * can be closed again or simply scrolled past; the matching pins stay lit
 * while the rest of the network dims.
 *
 * What a need leads to happens in the conversation too: applying to serve,
 * booking a call, signing in. layer() hands out something with the dialog
 * layer's show(build) — so the same forms the dialogs use are built here —
 * and mounts what it builds as a card in the thread instead of a window. Follow-ups go in the composer at the
 * foot and are answered with the conversation so far in hand.
 *
 * When the guide cannot be reached — no backend, no key, a network blip — the
 * same question is answered by the keyword search instead, so the panel always
 * has something true to show.
 *
 * A ministry posts a need here too (startPost): it says what it needs in its
 * own words, the post form sits in the conversation filling itself in as it
 * talks (draft-need), and it posts from the form when the form reads right.
 */
import { add, clear, h, icons, nf, plural, since, svg } from "./dom.js";
import { emptyQuery } from "../data/network.js";
import { FOCUS_BY_ID, REGION_BY_ID, TYPE_BY_ID, URGENCY_BY_ID } from "../data/taxonomy.js";
import { pullToClose } from "./swipe.js";
import { AuthGate } from "./auth.js";
import { deleteChat, getChat, listChats, newChatId, saveChat } from "./chats.js";
import { needForm, needPosted } from "./ministry.js";

/** Said to start posting a need from the composer ("I'd like to post a need"). */
const POST_INTENT =
  /^\s*(?:(?:i|we)(?:'d| would)? (?:want|like|need) to |(?:can|could|may) (?:i|we) |how (?:do|can) (?:i|we) |help (?:me|us) |let'?s |please )?(?:post|add|create|list|submit|put up|publish)\s+(?:a |an |our |my |another |one more )?(?:new )?(?:need|request|opportunity|role|volunteer (?:need|role|request))\b/i;
/** Said, once the form is ready, to post it ("post it", "looks good"). */
const POST_IT = /^\s*(?:yes|yep|yeah|ok(?:ay)?|sure|great|perfect|looks (?:good|great|right)|that'?s (?:right|good|great)|go ahead|post(?: it| this| the need)?|publish(?: it)?|submit(?: it)?|do it)\b[\s.,!]*(?:(?:go ahead and |please )?(?:post(?: it)?|publish(?: it)?)|please|thanks?(?: you)?)?[\s.,!]*$/i;
/** The placeholder the composer goes back to when posting ends. */
const FOLLOW_UP = "Ask a follow-up…";

const send = () => svg("0 0 16 16", '<path d="M8 12.8V3.4M4.2 7.2 8 3.4l3.8 3.8"/>');
const clock = () => svg("0 0 16 16", '<circle cx="8" cy="8" r="5.8"/><path d="M8 4.8V8l2.2 1.5"/>');
const bin = () => svg("0 0 16 16", '<path d="M3.2 4.6h9.6M6.4 4.6V3.2h3.2v1.4M4.4 4.6l.6 8.2h6l.6-8.2"/>');
const fresh = () => svg("0 0 16 16", '<path d="M11.2 2.6 13.4 4.8 7 11.2l-3 .8.8-3z"/><path d="M2.6 13.4h10.8"/>');
/**
 * Terra's guide: a soft blue cloud with happy closed eyes, cyan at its left
 * edge deepening to blue, glowing. Drawn rather than an image so it is sharp
 * at any size and can be animated — the one answering hops while it thinks
 * (`thinking`), squashing as it lands, over a shadow that shrinks as it
 * rises. The cloud is overlapping circles under one gradient laid out in the
 * drawing's own units, so they read as a single shape. Each copy has its own
 * gradient ids: a document with two elements of the same id paints the
 * second from the first, and the first may be gone.
 */
let mascots = 0;
const MASCOT_PUFFS = [
  [60, 60, 38],
  [62, 32, 22],
  [38, 44, 18],
  [86, 46, 18],
  [24, 64, 17],
  [98, 64, 16],
  [44, 72, 22],
  [78, 72, 22],
];
const avatar = (thinking = false) => {
  const id = `terra-guide-${++mascots}`;
  const puffs = MASCOT_PUFFS.map(([cx, cy, r]) => `<circle cx="${cx}" cy="${cy}" r="${r}"/>`).join("");
  return h(
    "span",
    { class: `ask__avatar${thinking ? " is-thinking" : ""}`, "aria-hidden": "true" },
    h("span", { class: "ask__shadow" }),
    svg(
      "0 0 120 100",
      `<defs>
        <linearGradient id="${id}-fill" gradientUnits="userSpaceOnUse" x1="8" y1="40" x2="114" y2="80">
          <stop offset="0" stop-color="#2ce8f4"/>
          <stop offset="0.45" stop-color="#14a8f0"/>
          <stop offset="1" stop-color="#1688f2"/>
        </linearGradient>
        <radialGradient id="${id}-shade" gradientUnits="userSpaceOnUse" cx="56" cy="44" r="58">
          <stop offset="0.45" stop-color="#1688f2"/>
          <stop offset="1" stop-color="#062a5c"/>
        </radialGradient>
      </defs>
      <g class="ask__mascot-body">
        <g fill="url(#${id}-fill)">${puffs}</g>
        <g fill="url(#${id}-shade)" opacity="0.3" style="mix-blend-mode:multiply">${puffs}</g>
        <g class="ask__mascot-eyes" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round">
          <path d="M39 50a6.5 6.5 0 0 1 13 0"/>
          <path d="M70 50a6.5 6.5 0 0 1 13 0"/>
        </g>
      </g>`,
      "ask__mascot",
    ),
  );
};

/** How many needs the guide reads at once (its own cap, ask-terra). */
const POOL = 160;

const STOP = new Set("the and for with that this what could from have want would like some any are can you your about into who how where when need needs help".split(" "));
const words = (s) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
const URGENCY_RANK = { urgent: 0, soon: 1, ongoing: 2 };

/**
 * The needs most likely to answer `text`, best first, for the guide to choose
 * from: the network is larger than it can read, so the page narrows it.
 * Words that name a place count most, then the title, skills and tags, then
 * the rest of the need. With nothing to go on, the most urgent and newest.
 */
function shortlist(text, needs) {
  const asked = new Set(words(text));
  const score = (n) => {
    if (!asked.size) return 0;
    const field = (v, weight) => words(v).reduce((a, w) => a + (asked.has(w) || [...asked].some((q) => q.length > 4 && w.startsWith(q.slice(0, -1))) ? weight : 0), 0);
    return (
      field([n.city, n.country, REGION_BY_ID.get(n.region)?.label].join(" "), 5) +
      field([n.title, ...(n.skills ?? []), ...(n.tags ?? [])].join(" "), 3) +
      field([FOCUS_BY_ID.get(n.focus)?.label, TYPE_BY_ID.get(n.type)?.label, n.ministryName, n.commitment].join(" "), 2) +
      field(n.detail, 1)
    );
  };
  return needs
    .map((n) => ({ n, s: score(n) }))
    .sort(
      (a, b) =>
        b.s - a.s ||
        (URGENCY_RANK[a.n.urgency] ?? 3) - (URGENCY_RANK[b.n.urgency] ?? 3) ||
        String(b.n.posted).localeCompare(String(a.n.posted)),
    )
    .slice(0, POOL)
    .map((x) => x.n);
}

/** A pick's identity in the thread: its need's id, or its own key for a web find. */
const keyOf = (p) => p.need?.id ?? p.key;

const distance = (d) =>
  d == null ? "" : d < 1 ? "under a mile away" : `${d < 10 ? Number(d).toFixed(1) : Math.round(d)} miles away`;

const mailIcon = () => svg("0 0 16 16", '<rect x="2.2" y="3.6" width="11.6" height="8.8" rx="1.6"/><path d="M2.6 4.4 8 8.6l5.4-4.2"/>');
const phoneIcon = () =>
  svg("0 0 16 16", '<path d="M5.6 2.6 4 2.8c-.8.1-1.4.9-1.2 1.7.9 4.2 4.4 7.7 8.6 8.6.8.2 1.6-.4 1.7-1.2l.2-1.6-2.6-1.2-1.2 1.2c-1.5-.7-2.7-1.9-3.4-3.4l1.2-1.2z"/>');
const linkIcon = () => svg("0 0 16 16", '<path d="M9.4 2.8h3.8v3.8M13.2 2.8 7.6 8.4M11.4 9.4v3.2a.8.8 0 0 1-.8.8H3.4a.8.8 0 0 1-.8-.8V5.4a.8.8 0 0 1 .8-.8h3.2"/>');

const EXAMPLES = [
  "I have a free afternoon — what could I do?",
  "I want to serve in the Philippines",
  "Anything for a nurse?",
  "Urgent needs I can do from home",
];

export class AskPanel {
  constructor({ net, ask, onGo, onFlyTo, onPlace, onServe, onSchedule, onSignedIn, onResults, onToggle, onReset, onMinistry, onEdit, onLeave, onPost }) {
    this.onSignedIn = onSignedIn;
    // "I'd like to post a need", said in the composer: the app checks who is
    // asking and calls startPost when they can.
    this.onPost = onPost;
    // The need being posted, while one is (startPost).
    this.posting = null;
    // A need's ministry, opened in the thread; a ministry's own need, to
    // edit; and a ministry's card
    // closed, which lets go of its pin. `onEdit(need)` answers with the edit
    // action, or null when the need is not the visitor's own.
    this.onMinistry = onMinistry;
    this.onEdit = onEdit;
    this.onLeave = onLeave;
    this.onReset = onReset;
    this.onPlace = onPlace;
    this.net = net;
    this.ask = ask;
    this.onFlyTo = onFlyTo;
    // "Bring me to Santa Barbara": answers with the line to reply with once
    // the globe is on its way there, or null when it is a question after all.
    this.onGo = onGo;
    this.onServe = onServe;
    this.onSchedule = onSchedule;
    this.onResults = onResults;
    this.onToggle = onToggle;
    this.turns = [];
    // The conversation in hand, saved as it goes (chats.js).
    this.chatId = newChatId();
    this.open = false;
    this.busy = false;
    this.active = null;

    this.thread = h("div", { class: "ask__thread scroll" });
    this.input = h("input", {
      class: "ask__input",
      type: "text",
      placeholder: FOLLOW_UP,
      "aria-label": "Ask Terra a follow-up",
      enterkeyhint: "send",
      autocomplete: "off",
    });
    this.sendBtn = h("button", { class: "ask__send", type: "submit", "aria-label": "Send" }, send());
    const form = h("form", { class: "ask__composer" }, this.input, this.sendBtn);
    const foot = h(
      "div",
      { class: "ask__foot" },
      form,
      h("p", { class: "ask__note", text: "Terra suggests needs from the live network. Check the details with the ministry." }),
    );
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const q = this.input.value.trim();
      if (!q || this.busy) return;
      this.input.value = "";
      this.#send(q);
    });

    this.head = h(
      "div",
      { class: "ask__head" },
      h("button", { class: "ask__title", type: "button", onclick: () => this.root.classList.remove("is-min") },
        avatar(),
        h("span", { class: "ask__name" },
          h("b", { text: "Ask Terra" }),
          h("span", { class: "ask__count", text: "Finds the needs that fit you" }),
        ),
      ),
      h("button", { class: "ask__new ask__hist-btn", type: "button", title: "Past chats", "aria-label": "Past chats", "aria-expanded": "false", onclick: () => this.#toggleHistory() }, clock()),
      h("button", { class: "ask__new", type: "button", title: "New chat", "aria-label": "New chat" }, fresh()),
      h("button", { class: "ask__x", type: "button", "aria-label": "Close", onclick: () => this.close() }, icons.close()),
    );

    // Past chats: a list in place of the thread, opened from the clock.
    this.history = h("div", { class: "ask__history scroll", hidden: true, "aria-label": "Past chats" });

    this.root = h(
      "aside",
      { class: "ask", "aria-label": "Ask Terra", hidden: true },
      this.head,
      this.thread,
      this.history,
      foot,
    );
    this.head.querySelector(".ask__new:not(.ask__hist-btn)").addEventListener("click", () => this.reset());
    document.body.appendChild(this.root);
    pullToClose(this.root, { onClose: () => this.close() });
    window.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || !this.open || document.querySelector(".modal")) return;
      // The list of past chats first, then the conversation.
      if (this.root.classList.contains("is-history")) this.#closeHistory();
      else this.close();
    });
  }

  /**
   * The composer: a place asked for by name is gone to, with a line in the
   * thread to say so; anything else is a question.
   */
  async #send(text) {
    if (this.posting) return this.#postTurn(text);
    if (this.onPost && POST_INTENT.test(text)) {
      this.onPost(text);
      return;
    }
    if (!this.onGo) return this.submit(text);
    this.busy = true;
    const said = await this.onGo(text).catch(() => null);
    this.busy = false;
    if (!said) return this.submit(text);
    // Kept out of the agent's history (local): it did not answer them.
    this.turns.push({ role: "user", text, local: true }, { role: "assistant", text: said, picks: [], local: true });
    this.render();
  }

  /** A question from the find bar or the composer. */
  async submit(question) {
    this.#show();
    this.root.classList.remove("is-min");
    this.#closeHistory();
    // Everything said and shown so far, so a follow-up ("the second one",
    // "that church", "anything closer?") means what it meant to the visitor.
    const history = this.#context();
    const referenced = this.#referenced();
    for (const t of this.turns) t.open = null;
    this.turns.push({ role: "user", text: question });
    const answer = { role: "assistant", text: "", picks: [], pending: true };
    this.turns.push(answer);
    this.busy = true;
    this.render();

    // What was asked, with the visitor's earlier turns: a follow-up ("what
    // about in Kenya?") still means the thing asked about before it.
    const asked = this.turns.filter((t) => t.role === "user").map((t) => t.text).join(" ");
    // The needs already in the conversation stay choosable, ahead of the
    // shortlist for what was just asked.
    const refIds = new Set(referenced.map((n) => n.id));
    const needs = [...referenced, ...shortlist(asked, this.net.needs).filter((n) => !refIds.has(n.id))].slice(0, POOL);
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

  /* ----------------------------------------------------- flows in the thread */

  /**
   * A stand-in for the dialog layer: `show(build)` mounts the built form as
   * a card in the thread, under a line in the visitor's words (`said`), and
   * its close() takes the card away again. `onClose` hears the visitor
   * closing it with its own ✕, and only that.
   */
  layer(said, { onClose } = {}) {
    return { show: (build) => this.#flow(build, said, onClose) };
  }

  #flow(build, said, onClose) {
    this.#show();
    this.root.classList.remove("is-min");
    if (said) this.turns.push({ role: "user", text: said, local: true });
    const turn = { role: "flow" };
    const close = () => {
      const i = this.turns.indexOf(turn);
      if (i < 0) return;
      this.turns.splice(i, 1);
      this.render({ keepScroll: true });
    };
    turn.el = h(
      "section",
      { class: "ask__flow" },
      h("button", { class: "ask__flow-x", type: "button", "aria-label": "Close", onclick: () => (close(), onClose?.()) }, icons.close()),
    );
    add(turn.el, [build(close)]);
    this.turns.push(turn);
    this.render({ keepScroll: true });
    requestAnimationFrame(() => {
      turn.el.scrollIntoView({ behavior: "smooth", block: "start" });
      turn.el.querySelector("[data-autofocus], input, textarea")?.focus({ preventScroll: true });
    });
    return turn.el;
  }

  /* ------------------------------------------------------- posting a need */

  /**
   * Posting a need as a conversation. The post form goes into the thread as a
   * card, every choice on it unmade, and from here on the composer talks to
   * `draft` (draft-need) rather than to the search: each thing the ministry
   * says comes back as the form brought up to date — the fields it changed
   * lit for a moment — and the guide's next question. The ministry can type
   * into the form as well; what is in it is sent with every turn, so the
   * guide works from it rather than over it. `post` sends the finished form
   * through the same check as ever (moderate-need), from the card's own
   * button or from saying "post it" once the guide calls it ready.
   */
  startPost({ ministry, draft, post, onPosted, said = "I'd like to post a need" }) {
    this.#show();
    this.root.classList.remove("is-min");
    this.#closeHistory();
    for (const t of this.turns) t.open = null;
    this.#endPost();

    const form = needForm({ ministry, blank: true });
    const err = h("span", { class: "modal__note ask__post-err", role: "alert" });
    const go = h("button", { class: "btn btn--accent", type: "button" }, "Post this need");
    const card = h(
      "section",
      { class: "ask__flow ask__post" },
      h("button", { class: "ask__flow-x", type: "button", "aria-label": "Stop posting this need", onclick: () => this.#cancelPost() }, icons.close()),
      h("div", { class: "modal__inner" },
        h("div", { class: "modal__body" },
          h("div", { class: "modal__eyebrow", text: "New need" }),
          h("h2", { class: "modal__title", text: `For ${ministry.name}` }),
          h("p", { class: "modal__lede", text: "This fills itself in as we talk, and you can change anything in it yourself. Everything posted is checked before it appears on the globe." }),
          form.el,
        ),
        h("div", { class: "modal__foot" }, err, h("span", { class: "spacer" }), go),
      ),
    );
    const posting = { id: newChatId(), ministry, form, draft, post, onPosted, ready: false, card, go, err };
    posting.turn = { role: "flow", el: card, post: posting.id };
    go.addEventListener("click", () => this.#postNow(posting));
    this.posting = posting;

    this.turns.push(
      { role: "user", text: said, local: true, post: posting.id },
      {
        role: "assistant",
        text: `Let's put it on the map for ${ministry.name}. Tell me what you need help with, in your own words, and I'll fill in the form as we go.`,
        picks: [],
        local: true,
        post: posting.id,
      },
      posting.turn,
    );
    this.input.placeholder = "Describe the need, or answer the question…";
    this.render();
    requestAnimationFrame(() => this.input.focus({ preventScroll: true }));
  }

  /** Whether `text` asks to post a need, from the find bar as from the composer. */
  wantsToPost(text) {
    return POST_INTENT.test(text);
  }

  /** One thing the ministry said while posting: the form updated, and the next question. */
  async #postTurn(text) {
    const p = this.posting;
    if (p.ready && POST_IT.test(text)) {
      this.turns.push({ role: "user", text, local: true, post: p.id });
      this.#toEnd(p.turn);
      this.render();
      return this.#postNow(p);
    }
    this.turns.push({ role: "user", text, local: true, post: p.id });
    const answer = { role: "assistant", text: "", picks: [], pending: true, status: "Filling in the form…", local: true, post: p.id };
    this.turns.push(answer);
    // The form stays under the newest exchange, where the eye already is.
    this.#toEnd(p.turn);
    this.busy = true;
    this.render();

    try {
      const res = await p.draft({ history: this.#postHistory(p), draft: p.form.values() });
      if (this.posting !== p) return;
      p.form.set(res.draft);
      p.ready = res.ready;
      answer.text = res.reply;
    } catch {
      answer.text = "I couldn't reach the guide just now. You can fill in the form below yourself and post it from there.";
    }
    answer.pending = false;
    this.busy = false;
    this.render();
  }

  /** What has been said about this need, for draft-need. */
  #postHistory(p) {
    return this.turns
      .filter((t) => t.post === p.id && (t.role === "user" || t.role === "assistant") && !t.pending && t.text)
      .map((t) => ({ role: t.role, text: t.text }));
  }

  /** Sends the form through the check, and shows how it went where the form was. */
  async #postNow(p) {
    if (this.posting !== p || p.sending) return;
    const missing = p.form.missing();
    if (missing.length) {
      const list = missing.length > 1 ? `${missing.slice(0, -1).join(", ")} and ${missing.at(-1)}` : missing[0];
      p.err.textContent = `Add ${list} first.`;
      this.say(`Nearly there. The form still needs ${list}. Tell me, or fill it in below.`);
      return;
    }
    p.sending = true;
    p.err.textContent = "";
    p.go.disabled = true;
    p.go.textContent = "Checking…";
    let res;
    try {
      res = await p.post({ ministry_id: p.ministry.id, ...p.form.values(), remote: true });
    } catch (e) {
      p.sending = false;
      p.go.disabled = false;
      p.go.textContent = "Post this need";
      p.err.textContent = String(e?.message ?? e);
      return;
    }
    // The card becomes the receipt; the conversation goes back to searching.
    clear(p.card);
    add(p.card, [needPosted(res)]);
    this.#endPost();
    this.say(
      res.status === "live"
        ? "Done. It's on the globe now, and volunteers can find it straight away."
        : "Done. It's posted and waiting for a quick review before it shows on the globe.",
    );
    p.onPosted?.(res);
  }

  /** The card's ✕: nothing is posted, and the form goes. */
  #cancelPost() {
    const p = this.posting;
    if (!p) return;
    const i = this.turns.indexOf(p.turn);
    if (i >= 0) this.turns.splice(i, 1);
    this.#endPost();
    this.say("No problem, nothing was posted. Your words are still here if you want to come back to it.");
  }

  /** Back to searching: the composer talks to the guide again. */
  #endPost() {
    if (!this.posting) return;
    this.posting = null;
    this.busy = false;
    this.input.placeholder = FOLLOW_UP;
  }

  #toEnd(turn) {
    const i = this.turns.indexOf(turn);
    if (i >= 0) this.turns.push(...this.turns.splice(i, 1));
  }

  /**
   * Serve locally: what the guide found inside the visitor's circle — Terra
   * needs, and opportunities read off local churches' and ministries' own
   * websites. `run(status)` does the looking and resolves to
   * `{ reply, picks }`, calling status(text, { step, to, tau }) with what it
   * is doing meanwhile, so a search that takes half a minute shows its
   * progress: the line says what, and the bar under it eases towards `to`
   * (a share of the whole) over about `tau` seconds, slowing as it nears it,
   * so it never stands still and never claims to be done before it is.
   * `place` names where the circle is when it is not round the visitor.
   * `onAdjust` puts the radius back in the visitor's hands. A new search
   * replaces the last one rather than stacking under it.
   */
  async findLocal({ miles, place, run, onAdjust }) {
    this.#show();
    this.root.classList.remove("is-min");
    for (const t of this.turns) t.open = null;
    if (this.localTurn) {
      const i = this.turns.indexOf(this.localTurn);
      if (i > 0) this.turns.splice(i - 1, 2);
    }
    const said = `Find ministry opportunities within ${miles} mile${miles === 1 ? "" : "s"} of ${place ?? "me"}`;
    this.turns.push({ role: "user", text: said, local: true });
    const answer = { role: "assistant", text: "", picks: [], pending: true, local: true, nearby: true, onAdjust, progress: 0.04, step: 1 };
    this.localTurn = answer;
    this.turns.push(answer);
    this.busy = true;
    this.active = null;
    this.render();

    let to = 0.08;
    let tau = 3;
    const paint = () => {
      const bar = this.thread.querySelector(".ask__bar");
      if (!bar) return;
      bar.style.setProperty("--p", answer.progress.toFixed(4));
      bar.setAttribute("aria-valuenow", String(Math.round(answer.progress * 100)));
      const step = this.thread.querySelector(".ask__step");
      if (step) step.textContent = `Step ${answer.step} of 3`;
    };
    let last = performance.now();
    const tick = setInterval(() => {
      const now = performance.now();
      answer.progress += (to - answer.progress) * (1 - Math.exp(-(now - last) / 1000 / tau));
      last = now;
      paint();
    }, 120);
    const status = (text, next = {}) => {
      if (this.localTurn !== answer || !answer.pending) return;
      answer.status = text;
      if (next.step) answer.step = next.step;
      if (next.to) to = Math.max(to, next.to);
      if (next.tau) tau = next.tau;
      const el = this.thread.querySelector(".ask__status");
      if (el) el.textContent = text;
      paint();
    };
    let result;
    try {
      result = await run(status);
    } finally {
      clearInterval(tick);
    }
    if (this.localTurn !== answer) return;
    // The bar fills before the answer replaces it.
    answer.progress = 1;
    paint();
    await new Promise((r) => setTimeout(r, 380));
    if (this.localTurn !== answer) return;
    Object.assign(answer, { text: result.reply, picks: result.picks, pending: false });
    this.busy = false;
    this.render();
    this.onResults?.(answer.picks.filter((p) => p.need).map((p) => p.need));
  }

  /**
   * A ministry, in the thread: what the side rail used to show — who they
   * are, where, what they work on, everything they are asking for and how to
   * reach them — as a card under Terra's mark. `need` opens one of its needs
   * straight away, under its own card. The same ministry opened again moves
   * to the foot of the thread rather than appearing twice.
   */
  showMinistry(ministry, { need = null } = {}) {
    this.#show();
    this.root.classList.remove("is-min");
    for (const t of this.turns) t.open = null;
    const i = this.turns.findIndex((t) => t.role === "place" && t.ministry.id === ministry.id);
    if (i >= 0) this.turns.splice(i, 1);
    const turn = { role: "place", ministry, open: need?.id ?? null };
    this.turns.push(turn);
    this.active = turn.open;
    this.render({ keepScroll: true });
    requestAnimationFrame(() => {
      const card = this.thread.querySelector(`[data-place="${CSS.escape(String(ministry.id))}"]`);
      const detail = need && card?.querySelector(".ask__detail");
      (detail ?? card)?.scrollIntoView({ behavior: "smooth", block: detail ? "nearest" : "start" });
    });
  }

  #leavePlace(turn) {
    const i = this.turns.indexOf(turn);
    if (i >= 0) this.turns.splice(i, 1);
    if (this.active && turn.open === this.active) this.active = null;
    this.render({ keepScroll: true });
    this.onLeave?.(turn.ministry);
  }

  #place(t) {
    const m = this.net.ministryById.get(t.ministry.id) ?? t.ministry;
    const needs = this.net.rank ? this.net.rank(m.needs ?? []) : (m.needs ?? []);
    // A row with nothing in it reads as data that failed to load, so only
    // what the ministry filled in.
    const fact = (k, v) => (v ? h("div", { class: "ask__fact" }, h("span", { text: k }), h("b", {}, v)) : null);
    const facts = [
      fact("Team", m.staff ? plural(m.staff, "person", "people") : null),
      fact("Languages", m.languages?.length ? m.languages.join(", ") : null),
      fact("People wanted", m.peopleWanted ? nf.format(m.peopleWanted) : null),
      fact("Contact", m.contact ? h("a", { href: `mailto:${m.contact}`, text: m.contact }) : null),
    ].filter(Boolean);
    return h(
      "div",
      { class: "ask__a", "data-place": String(m.id) },
      avatar(),
      h("section", { class: "ask__body ask__place", "aria-label": m.name },
        h("div", { class: "ask__place-head" },
          h("h3", { class: "ask__place-name", text: m.name }),
          h("button", { class: "ask__detail-x", type: "button", "aria-label": `Close ${m.name}`, onclick: () => this.#leavePlace(t) }, icons.close()),
        ),
        h("p", { class: "ask__detail-where" },
          icons.pin(),
          [[m.city, m.country].filter(Boolean).join(", "), m.since ? `since ${m.since}` : ""].filter(Boolean).join(" · "),
        ),
        m.blurb ? h("p", { class: "ask__place-blurb", text: m.blurb }) : null,
        m.focus?.length ? h("div", { class: "ask__skills" }, ...m.focus.map((f) => h("span", { text: FOCUS_BY_ID.get(f)?.label ?? f }))) : null,
        h("div", { class: "ask__label" }, h("span", { text: "Open needs" }), h("span", { text: String(needs.length) })),
        needs.length
          ? h("div", { class: "ask__cards ask__cards--one" },
              ...needs.flatMap((n) => {
                const p = { need: n, why: "" };
                return [this.#card(p, t), t.open === n.id ? this.#detail(n, t, { inPlace: true }) : null];
              }),
            )
          : h("p", { class: "ask__muted", text: "Nothing open right now." }),
        facts.length ? h("div", { class: "ask__facts" }, ...facts) : null,
      ),
    );
  }

  /** A line from Terra that no question asked: a confirmation, say. */
  say(text) {
    this.turns.push({ role: "assistant", text, picks: [], local: true });
    this.render({ keepScroll: true });
    requestAnimationFrame(() => this.thread.lastElementChild?.scrollIntoView({ behavior: "smooth", block: "end" }));
  }

  /** Signing in, as a card in the thread; `then` runs once it has worked. */
  signIn(mode = "signin", { then, said = "I'd like to sign in" } = {}) {
    let gate = null;
    const card = this.layer(said).show((close) => {
      gate = new AuthGate({
        inline: true,
        onClose: close,
        onSignedIn: async () => {
          await this.onSignedIn?.();
          this.say("You're signed in.");
          then?.();
        },
      });
      return gate.card;
    });
    gate.open(mode);
    return card;
  }

  /* --------------------------------------------------- memory and past chats */

  /**
   * The conversation as the guide is told it: every question, every answer
   * with what it showed (numbered, as the visitor saw them), the ministries
   * opened and the need opened under one — newest last. The function keeps
   * as much of the end of it as fits.
   */
  #context() {
    const out = [];
    const needLine = (n) => `${n.title} — ${n.ministryName}, ${[n.city, n.country].filter(Boolean).join(", ")} [id ${n.id}]`;
    const webLine = (w) =>
      `${w.title} — ${w.org || w.name}${w.town ? `, ${w.town}` : ""} (found on their website, not on Terra${w.email ? `; email ${w.email}` : ""}${w.summary ? `; ${w.summary}` : ""})`;
    for (const t of this.turns) {
      // Posting a need is its own conversation, with draft-need.
      if (t.pending || t.role === "flow" || t.post) continue;
      if (t.role === "user") {
        out.push({ role: "user", text: t.text });
        continue;
      }
      if (t.role === "place") {
        const m = this.net.ministryById.get(t.ministry.id) ?? t.ministry;
        const needs = (m.needs ?? []).map((n, i) => `  ${i + 1}. ${needLine(n)}`).join("\n");
        const opened = t.open && this.net.needById?.(t.open);
        out.push({
          role: "assistant",
          text: [
            `[Showed the ministry ${m.name}, ${[m.city, m.country].filter(Boolean).join(", ")}${m.blurb ? `: ${m.blurb}` : ""}]`,
            needs ? `Its open needs:\n${needs}` : "",
            opened ? `The visitor opened: ${opened.title}` : "",
          ].filter(Boolean).join("\n"),
        });
        continue;
      }
      const shown = t.picks.map((p, i) => `  ${i + 1}. ${p.web ? webLine(p.web) : needLine(p.need)}`).join("\n");
      const opened = t.picks.find((p) => keyOf(p) === t.open);
      out.push({
        role: "assistant",
        text: [
          t.nearby ? "[Searched near the visitor for local churches and ministries]" : "",
          t.text,
          shown ? `Shown to the visitor:\n${shown}` : "",
          opened ? `The visitor opened: ${opened.web ? opened.web.title : opened.need.title}` : "",
        ].filter(Boolean).join("\n"),
      });
    }
    return out;
  }

  /** The Terra needs the conversation has shown, newest first. */
  #referenced() {
    const seen = new Set();
    const out = [];
    const add = (n) => {
      const fresh = n && (this.net.needById?.(n.id) ?? n);
      if (fresh && !seen.has(fresh.id)) seen.add(fresh.id) && out.push(fresh);
    };
    for (const t of [...this.turns].reverse()) {
      if (t.role === "place") (this.net.ministryById.get(t.ministry.id)?.needs ?? []).forEach(add);
      else if (t.picks) t.picks.forEach((p) => add(p.need));
    }
    return out.slice(0, 60);
  }

  /** The chat as data, for chats.js; null while there is nothing to keep. */
  #serial() {
    const turns = [];
    for (const t of this.turns) {
      if (t.pending || t.role === "flow") continue;
      if (t.role === "user") turns.push({ role: "user", text: t.text, local: !!t.local });
      else if (t.role === "place") turns.push({ role: "place", ministry: t.ministry.id });
      else
        turns.push({
          role: "assistant",
          text: t.text,
          local: !!t.local,
          nearby: !!t.nearby,
          fallback: !!t.fallback,
          picks: t.picks.map((p) => (p.web ? { web: p.web, why: p.why, key: p.key } : { need: p.need.id, why: p.why })),
        });
    }
    if (!turns.some((t) => t.role === "user" || t.role === "place")) return null;
    const first = turns.find((t) => t.role === "user");
    const place = turns.find((t) => t.role === "place");
    const title = first?.text ?? this.net.ministryById.get(place?.ministry)?.name ?? "Conversation";
    const last = [...turns].reverse().find((t) => t.role === "assistant" && t.text);
    return { id: this.chatId, title: title.slice(0, 80), preview: (last?.text ?? "").slice(0, 140), turns };
  }

  #save() {
    const chat = this.#serial();
    if (!chat) return;
    // Only a real change moves it up the list: re-rendering an old chat to
    // read it is not using it.
    const json = JSON.stringify(chat.turns);
    if (json === this.savedJson) return;
    this.savedJson = json;
    saveChat({ ...chat, updated: Date.now() });
  }

  /** A saved chat, back in the thread: its needs and ministries as they are now. */
  #load(id) {
    const chat = getChat(id);
    if (!chat) return;
    const turns = [];
    for (const t of chat.turns) {
      if (t.role === "user") turns.push({ role: "user", text: t.text, local: t.local });
      else if (t.role === "place") {
        const m = this.net.ministryById.get(t.ministry);
        if (m) turns.push({ role: "place", ministry: m, open: null });
      } else {
        const picks = (t.picks ?? [])
          .map((p) => (p.web ? { web: p.web, why: p.why, key: p.key } : { need: this.net.needById?.(p.need), why: p.why }))
          .filter((p) => p.web || p.need);
        turns.push({ role: "assistant", text: t.text, picks, local: t.local, nearby: t.nearby, fallback: t.fallback });
      }
    }
    this.chatId = chat.id;
    this.savedJson = JSON.stringify(chat.turns);
    this.localTurn = null;
    this.busy = false;
    this.active = null;
    this.turns = turns;
    this.#closeHistory();
    this.render();
    // The pins of its last answer light up again.
    const last = [...turns].reverse().find((t) => t.role === "assistant" && t.picks?.length);
    this.onResults?.(last ? last.picks.filter((p) => p.need).map((p) => p.need) : []);
  }

  #toggleHistory() {
    if (this.root.classList.contains("is-history")) this.#closeHistory();
    else this.#openHistory();
  }

  #openHistory() {
    this.#show();
    this.root.classList.remove("is-min");
    this.root.classList.add("is-history");
    this.history.hidden = false;
    this.head.querySelector(".ask__hist-btn").setAttribute("aria-expanded", "true");
    this.#renderHistory();
  }

  #closeHistory() {
    if (!this.root.classList.contains("is-history")) return;
    this.root.classList.remove("is-history");
    this.history.hidden = true;
    this.head.querySelector(".ask__hist-btn").setAttribute("aria-expanded", "false");
  }

  #renderHistory() {
    const chats = listChats();
    const day = 864e5;
    const today = new Date().setHours(0, 0, 0, 0);
    const group = (t) => (t >= today ? "Today" : t >= today - day ? "Yesterday" : t >= today - 7 * day ? "Previous 7 days" : t >= today - 30 * day ? "Previous 30 days" : "Older");
    const when = (t) => {
      const d = new Date(t);
      if (t >= today) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      if (t >= today - 7 * day) return d.toLocaleDateString([], { weekday: "short" });
      return d.toLocaleDateString([], { month: "short", day: "numeric" });
    };
    clear(this.history);
    this.history.appendChild(
      h("div", { class: "ask__hist-head" },
        h("b", { text: "Past chats" }),
        h("button", { class: "ask__hist-new", type: "button", onclick: () => this.reset() }, fresh(), "New chat"),
      ),
    );
    if (!chats.length) {
      this.history.appendChild(
        h("div", { class: "ask__hist-empty" },
          clock(),
          h("b", { text: "No past chats yet" }),
          h("p", { text: "Your conversations with Terra are kept here, in this browser, so you can pick one up again." }),
        ),
      );
      return;
    }
    let heading = "";
    for (const c of chats) {
      const g = group(c.updated);
      if (g !== heading) {
        heading = g;
        this.history.appendChild(h("div", { class: "ask__hist-group", text: g }));
      }
      const row = h(
        "div",
        { class: `ask__hist-row${c.id === this.chatId ? " is-current" : ""}` },
        h("button", { class: "ask__hist-open", type: "button", onclick: () => this.#load(c.id) },
          h("span", { class: "ask__hist-title", text: c.title }),
          c.preview ? h("span", { class: "ask__hist-preview", text: c.preview }) : null,
        ),
        h("span", { class: "ask__hist-when", text: when(c.updated) }),
        h("button", {
          class: "ask__hist-del",
          type: "button",
          title: "Delete chat",
          "aria-label": `Delete “${c.title}”`,
          onclick: () => {
            deleteChat(c.id);
            // The open one deleted: the thread empties with it, rather than
            // saving it straight back.
            if (c.id === this.chatId) {
              this.chatId = newChatId();
              this.savedJson = null;
              this.localTurn = null;
              this.turns = [];
              this.active = null;
              this.render();
              this.onResults?.([]);
            }
            this.#renderHistory();
          },
        }, bin()),
      );
      this.history.appendChild(row);
    }
  }

  reset() {
    this.#closeHistory();
    this.#endPost();
    this.chatId = newChatId();
    this.localTurn = null;
    this.turns = [];
    this.active = null;
    this.render();
    this.onResults?.([]);
    this.onReset?.();
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

  /** A card opens its need under its answer, and the globe flies there. */
  #pick(p, turn) {
    const key = keyOf(p);
    const same = turn.open === key;
    for (const t of this.turns) t.open = null;
    turn.open = same ? null : key;
    this.active = turn.open;
    this.render({ keepScroll: true });
    if (!turn.open) return void (p.web && this.onPlace?.(null));
    if (p.web) this.onPlace?.(p.web);
    else this.onFlyTo?.(p.need);
    requestAnimationFrame(() =>
      this.thread.querySelector(".ask__detail")?.scrollIntoView({ behavior: "smooth", block: "nearest" }),
    );
  }

  #closeDetail(turn) {
    turn.open = null;
    this.active = null;
    this.render({ keepScroll: true });
  }

  /** The need itself, in the thread: what a card stands for, in full. */
  #detail(need, turn, { inPlace = false } = {}) {
    const n = this.net.needById?.(need.id) ?? need;
    // Only on the ministry's own needs: the way back in to change anything.
    const edit = this.onEdit?.(n);
    const cell = (label, value) => h("div", { class: "ask__cell" }, h("span", { text: label }), h("b", { text: value }));
    return h(
      "section",
      { class: "ask__detail", "aria-label": n.title },
      h("div", { class: "ask__detail-top" },
        h("span", { class: `dot dot--${n.urgency}` }),
        h("span", { class: "ml", text: TYPE_BY_ID.get(n.type)?.label ?? n.type }),
        n.remote ? h("span", { class: "ask__tag", text: "Remote OK" }) : null,
        h("button", { class: "ask__detail-x", type: "button", "aria-label": "Close details", onclick: () => this.#closeDetail(turn) }, icons.close()),
      ),
      h("h3", { class: "ask__detail-title", text: n.title }),
      h("p", { class: "ask__detail-where" },
        icons.pin(),
        [n.ministryName, [n.city, n.country].filter(Boolean).join(", "), n.posted ? `posted ${since(n.posted)}` : ""].filter(Boolean).join(" · "),
      ),
      h("div", { class: "ask__cells" },
        cell("Urgency", URGENCY_BY_ID.get(n.urgency)?.label ?? n.urgency),
        cell("People", n.people ? plural(n.people, "person", "people") : "Not people"),
        cell("Commitment", n.commitment || "Flexible"),
        cell("Focus", FOCUS_BY_ID.get(n.focus)?.label ?? "—"),
      ),
      h("p", { class: "ask__detail-text", text: n.detail || "No further detail was given." }),
      n.skills?.length ? h("div", { class: "ask__skills" }, ...n.skills.map((k) => h("span", { text: k }))) : null,
      h("div", { class: "ask__detail-foot" },
        h("button", { class: "btn btn--accent btn--serve", type: "button", onclick: () => this.onServe?.(n) }, n.taken ? "Withdraw interest" : "Serve"),
        this.onSchedule ? h("button", { class: "ask__ghost", type: "button", onclick: () => this.onSchedule(n) }, "Schedule a call") : null,
        h("button", { class: "ask__ghost", type: "button", onclick: () => this.onFlyTo?.(n) }, icons.pin(), "Show on map"),
        // From an answer, the way into everything else the ministry asks for;
        // inside the ministry's own card it would only point at itself.
        !inPlace && this.onMinistry ? h("button", { class: "ask__ghost", type: "button", onclick: () => this.onMinistry(n) }, "About the ministry") : null,
        edit ? h("button", { class: "ask__ghost", type: "button", onclick: edit }, icons.edit(), "Edit") : null,
      ),
    );
  }

  /** An opportunity read off a local organisation's own website, in full. */
  #webDetail(w, turn) {
    const host = (() => {
      try {
        return new URL(w.page).hostname.replace(/^www\./, "");
      } catch {
        return "";
      }
    })();
    const subject = `Volunteering: ${w.title}`;
    const body = `Hello,\n\nI found "${w.title}" on your website and would love to help. Could you tell me how to get started?\n\nThank you!`;
    const mail = w.email ? `mailto:${w.email}?${new URLSearchParams({ subject, body }).toString().replace(/\+/g, "%20")}` : null;
    return h(
      "section",
      { class: "ask__detail ask__detail--web", "aria-label": w.title },
      h("div", { class: "ask__detail-top" },
        h("span", { class: "dot dot--web" }),
        h("span", { class: "ml", text: w.orgKind || "Ministry" }),
        h("span", { class: "ask__tag ask__tag--web", text: "From their website" }),
        h("button", { class: "ask__detail-x", type: "button", "aria-label": "Close details", onclick: () => this.#closeDetail(turn) }, icons.close()),
      ),
      h("h3", { class: "ask__detail-title", text: w.title }),
      h("p", { class: "ask__detail-where" },
        icons.pin(),
        [w.org, w.address || w.town, distance(w.miles)].filter(Boolean).join(" · "),
      ),
      w.summary ? h("p", { class: "ask__detail-text", text: w.summary }) : null,
      h("div", { class: "ask__contact" },
        w.email
          ? h("a", { class: "ask__contact-row", href: mail }, mailIcon(), h("span", {}, h("b", { text: "Email" }), h("span", { text: w.email })))
          : null,
        w.phone
          ? h("a", { class: "ask__contact-row", href: `tel:${w.phone.replace(/[^\d+]/g, "")}` }, phoneIcon(), h("span", {}, h("b", { text: "Call" }), h("span", { text: w.phone })))
          : null,
        h("a", { class: "ask__contact-row", href: w.page, target: "_blank", rel: "noopener noreferrer" }, linkIcon(), h("span", {}, h("b", { text: "Read their page" }), h("span", { text: host }))),
      ),
      h("div", { class: "ask__detail-foot" },
        mail
          ? h("a", { class: "btn btn--accent btn--serve", href: mail }, mailIcon(), "Email them")
          : h("a", { class: "btn btn--accent btn--serve", href: w.page, target: "_blank", rel: "noopener noreferrer" }, "Visit their page"),
        // Found by its address, or by its name in the town for a web find.
        Number.isFinite(w.lat) || w.address || w.town
          ? h("button", { class: "ask__ghost", type: "button", onclick: () => this.onPlace?.(w) }, icons.pin(), "Show on map")
          : null,
      ),
      h("p", { class: "ask__source", text: `Found on ${host || "their website"} — details may have changed, so check with them before you go.` }),
    );
  }

  #webCard(p, turn) {
    const w = p.web;
    const key = keyOf(p);
    const card = h(
      "button",
      { class: `ask__card ask__card--web${this.active === key ? " is-active" : ""}`, type: "button" },
      h("span", { class: "ask__card-top" },
        h("span", { class: "dot dot--web" }),
        h("span", { class: "ml", text: w.orgKind || "Ministry" }),
        // Not on Terra: found on the map or the web by the agent.
        h("span", { class: "ask__tag ask__tag--web", text: "New to Terra" }),
        h("span", { class: "ask__fly" }, this.active === key ? "Open" : "Details", icons.arrow()),
      ),
      h("b", { class: "ask__card-title", text: w.title }),
      h("span", { class: "ask__card-where" }, icons.pin(), [w.org, w.town].filter(Boolean).join(" · ")),
      p.why ? h("span", { class: "ask__why", text: p.why }) : null,
      h("span", { class: "ask__commit", text: [distance(w.miles), w.email ? "email listed" : w.phone ? "phone listed" : ""].filter(Boolean).join(" · ") }),
    );
    card.setAttribute("aria-expanded", String(turn.open === key));
    card.addEventListener("click", () => this.#pick(p, turn));
    return card;
  }

  #card(p, turn) {
    if (p.web) return this.#webCard(p, turn);
    const n = p.need;
    const card = h(
      "button",
      { class: `ask__card${this.active === n.id ? " is-active" : ""}`, type: "button" },
      h("span", { class: "ask__card-top" },
        h("span", { class: `dot dot--${n.urgency}` }),
        h("span", { class: "ml", text: TYPE_BY_ID.get(n.type)?.label ?? n.type }),
        n.remote ? h("span", { class: "ask__tag", text: "Remote" }) : null,
        h("span", { class: "ask__fly" }, this.active === n.id ? "Open" : "Details", icons.arrow()),
      ),
      h("b", { class: "ask__card-title", text: n.title }),
      h("span", { class: "ask__card-where" },
        icons.pin(),
        `${n.ministryName} · ${[n.city, n.country].filter(Boolean).join(", ")}`,
      ),
      p.why ? h("span", { class: "ask__why", text: p.why }) : null,
      n.commitment ? h("span", { class: "ask__commit", text: n.commitment }) : null,
    );
    card.setAttribute("aria-expanded", String(turn.open === n.id));
    card.addEventListener("click", () => this.#pick(p, turn));
    return card;
  }

  render({ keepScroll = false } = {}) {
    const scroll = this.thread.scrollTop;
    clear(this.thread);
    const last = [...this.turns].reverse().find((t) => t.role === "assistant" && !t.pending && !t.local);
    this.head.querySelector(".ask__count").textContent = this.posting
      ? this.busy
        ? "Filling in your need…"
        : "Posting a need"
      : this.busy
      ? this.localTurn?.pending
        ? "Searching for places to serve…"
        : "Looking across the network…"
      : last?.picks.length
        ? `${last.picks.length} need${last.picks.length === 1 ? "" : "s"} found`
        : "Finds the needs that fit you";

    if (!this.turns.length) {
      add(this.thread, [
        h("div", { class: "ask__a" },
          avatar(),
          h("div", { class: "ask__body" },
            h("p", { class: "ask__reply", text: "Tell me what you'd like to do — your time, your skills, or where in the world — and I'll find the needs that fit." }),
            h("div", { class: "ask__examples" },
              ...EXAMPLES.map((q) => h("button", { class: "ask__example", type: "button", onclick: () => this.submit(q) }, q)),
            ),
          ),
        ),
      ]);
    }

    for (const t of this.turns) {
      if (t.role === "place") {
        this.thread.appendChild(this.#place(t));
        continue;
      }
      if (t.role === "flow") {
        this.thread.appendChild(t.el);
        continue;
      }
      if (t.role === "user") {
        this.thread.appendChild(h("div", { class: "ask__q", text: t.text }));
        continue;
      }
      if (t.pending && t.nearby) {
        // A local search takes a while: what it is doing, and how far along.
        const pct = Math.round(t.progress * 100);
        const bar = h("div", {
          class: "ask__bar",
          role: "progressbar",
          "aria-label": "Search progress",
          "aria-valuemin": "0",
          "aria-valuemax": "100",
          "aria-valuenow": String(pct),
        }, h("i"));
        bar.style.setProperty("--p", String(t.progress));
        this.thread.appendChild(
          h("div", { class: "ask__a" },
            avatar(true),
            h("div", { class: "ask__body ask__progress" },
              h("div", { class: "ask__progress-top" },
                h("span", { class: "ask__status", "aria-live": "polite", text: t.status ?? "Getting ready to search…" }),
                h("span", { class: "ask__step", text: `Step ${t.step} of 3` }),
              ),
              bar,
            ),
          ),
        );
        continue;
      }
      if (t.pending) {
        this.thread.appendChild(
          h("div", { class: "ask__a", "aria-live": "polite" },
            avatar(true),
            h("div", { class: "ask__body" },
              h("div", { class: "ask__reply ask__wait" },
                h("span", { class: "ask__dots" }, h("i"), h("i"), h("i")),
                h("span", { class: "ask__status", text: t.status ?? "Looking across the network…" }),
              ),
            ),
          ),
        );
        continue;
      }
      this.thread.appendChild(
        h("div", { class: `ask__a${t.nearby ? " is-local" : ""}`, "aria-live": "polite" },
          avatar(),
          h("div", { class: "ask__body" },
            h("p", { class: "ask__reply", text: t.text }),
            t.nearby && t.onAdjust
              ? h("div", { class: "ask__modes" },
                  h("button", { type: "button", onclick: () => t.onAdjust() }, icons.pin(), "Change the radius"),
                )
              : null,
            // An opened need sits straight under its own card.
            t.picks.length
              ? h("div", { class: "ask__cards" },
                  ...t.picks.flatMap((p) => [
                    this.#card(p, t),
                    t.open === keyOf(p) ? (p.web ? this.#webDetail(p.web, t) : this.#detail(p.need, t)) : null,
                  ]),
                )
              : null,
          ),
        ),
      );
    }

    // Only the answer being written hops; the guide in the header keeps still.
    this.sendBtn.disabled = this.busy;
    this.#save();
    if (keepScroll) {
      this.thread.scrollTop = scroll;
      return;
    }
    requestAnimationFrame(() => {
      // The newest exchange in view: the start of the answer, not its last card.
      const q = this.thread.querySelectorAll(".ask__q");
      const anchor = q[q.length - 1];
      if (anchor) this.thread.scrollTop = anchor.offsetTop - 8;
    });
  }
}
