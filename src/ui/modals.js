/**
 * Dialogs. One layer, one at a time, closed by scrim, Escape or the corner x.
 */
import { add, h, icons, plural, since } from "./dom.js";
import { FOCUS_BY_ID, NEED_TYPES, TYPE_BY_ID, URGENCIES, URGENCY_BY_ID } from "../data/taxonomy.js";
import { MINISTRIES, MINISTRY_BY_ID } from "../data/ministries.js";

const SIDE_ROOM = window.matchMedia("(min-width: 1000px)");

export class ModalLayer {
  constructor(root, { onToggle } = {}) {
    this.root = root;
    this.onToggle = onToggle;
    this.current = null;
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.current) {
        e.stopPropagation();
        this.close();
      }
    });
  }

  get isOpen() {
    return !!this.current;
  }

  /** Open, and covering the globe — a side card leaves it in view. */
  get covers() {
    return !!this.current && !this.current.side;
  }

  close() {
    if (!this.current) return;
    const { scrim, modal } = this.current;
    this.current = null;
    scrim.classList.add("is-out");
    modal.classList.add("is-out");
    this.onToggle?.(false);
    modal.addEventListener("animationend", () => {
      scrim.remove();
      modal.remove();
    });
  }

  /** Mounts a dialog; `build(close)` returns the body of the card. */
  show(build, { width, side = false } = {}) {
    this.close();
    // A side card stands beside a pin the globe has just flown to, so the
    // world stays in view and in play: no blur, and the scrim lets the
    // pointer through to the canvas. Only where there is room beside it.
    side = side && SIDE_ROOM.matches;
    const scrim = h("div", { class: side ? "scrim scrim--clear" : "scrim", onclick: () => this.close() });
    const modal = h("div", {
      class: side ? "modal modal--side" : "modal",
      role: "dialog",
      "aria-modal": "true",
      style: width && !side ? { width: `min(${width}px, calc(100vw - 32px))` } : null,
    });
    modal.appendChild(
      h("button", { class: "modal__x", "aria-label": "Close", onclick: () => this.close() }, icons.close()),
    );
    add(modal, [build(() => this.close())]);
    this.root.append(scrim, modal);
    this.current = { scrim, modal, side };
    this.onToggle?.(true);
    const focusTarget =
      modal.querySelector("[data-autofocus]") ??
      modal.querySelector("input,select,textarea,button:not(.modal__x)");
    focusTarget?.focus({ preventScroll: true });
    return modal;
  }
}

/* ------------------------------------------------------------------ about */

export function aboutModal(layer, { stats, onPostNeed }) {
  return layer.show(
    () =>
      h(
        "div",
        { class: "modal__inner" },
        h(
          "div",
          { class: "modal__body scroll" },
          h("div", { class: "modal__eyebrow", text: "About" }),
          h("h2", { class: "modal__title", text: "Serve ministries from anywhere" }),
          h(
            "div",
            { class: "prose" },
            h("p", {
              text:
                "Terra connects ministries around the world with people who can help them online. Every pin on the globe is a ministry, and every need is something that can be done from wherever you are.",
            }),
          ),
          h(
            "ol",
            { class: "steps" },
            h("li", {}, h("b", { text: "Ministries post what they need." }), " A logo, a part-time HR adviser, a bookkeeper, a translator, an online tutor — whatever would help."),
            h("li", {}, h("b", { text: "You offer your skills." }), " Search for what you do, or answer five questions and let Terra suggest needs that fit you."),
            h("li", {}, h("b", { text: "Meet on a video call." }), " Pick a time for a first conversation right in Terra, and a meeting link is sent to you both."),
          ),
          h("div", { class: "notice" }, [
            h("b", { text: "Everything on this map is fictional sample data." }),
            " The organisations, people and needs are invented for demonstration, and every contact address is on ",
            h("code", { text: "example.org" }),
            ", which cannot receive mail. Interests you express and needs you post are saved in this browser only.",
          ]),
          h(
            "div",
            { class: "prose" },
            h("p", {
              text:
                "Drag to rotate, scroll to zoom, double-click to fly somewhere. The filters narrow both the board and the globe: pins that fall outside your filters stay put but recede.",
            }),
          ),
        ),
        h(
          "div",
          { class: "modal__foot" },
          h("button", { class: "btn btn--accent", onclick: () => onPostNeed() }, "Post a need"),
          h("span", { class: "modal__note spacer", text: "Nothing here leaves your browser." }),
        ),
      ),
    { width: 660 },
  );
}

/* ----------------------------------------------------------- post a need */

export function postNeedModal(layer, { ministryId, onPublish }) {
  return layer.show((close) => {
    const field = (label, control) =>
      h("div", { class: "field" }, h("span", { class: "ml", text: label }), control);

    const ministry = h(
      "select",
      { class: "select", id: "f-ministry" },
      MINISTRIES.map((m) =>
        h("option", { value: m.id, selected: m.id === ministryId }, `${m.name} — ${m.city}`),
      ),
    );
    const title = h("input", {
      class: "input",
      id: "f-title",
      placeholder: "Swahili Bible study reviewers",
      autocomplete: "off",
      "data-autofocus": true,
    });
    const type = h(
      "select",
      { class: "select" },
      NEED_TYPES.map((t) => h("option", { value: t.id }, t.label)),
    );
    const urgency = h(
      "select",
      { class: "select" },
      URGENCIES.map((u) => h("option", { value: u.id, selected: u.id === "soon" }, u.label)),
    );
    const people = h("input", { class: "input", type: "number", min: "0", max: "500", value: "1" });
    const commitment = h("input", { class: "input", placeholder: "4 hrs/week · 3 months", autocomplete: "off" });
    const skills = h("input", { class: "input", placeholder: "Swahili, Theology", autocomplete: "off" });
    const detail = h("textarea", { class: "area", placeholder: "What the work involves and why it matters." });
    const remote = h("input", { type: "checkbox" });

    const error = h("span", { class: "modal__note", style: { color: "var(--urgent)" } });

    const publish = () => {
      const value = title.value.trim();
      if (!value) {
        title.setAttribute("aria-invalid", "true");
        title.focus();
        error.textContent = "Give the need a title first.";
        return;
      }
      onPublish({
        ministry: ministry.value,
        title: value,
        type: type.value,
        urgency: urgency.value,
        people: Math.max(0, Number(people.value) || 0),
        commitment: commitment.value.trim(),
        skills: skills.value
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        focus: MINISTRY_BY_ID.get(ministry.value)?.focus?.[0] ?? "children",
        detail: detail.value.trim(),
        remote: remote.checked,
      });
      close();
    };

    title.addEventListener("input", () => {
      title.removeAttribute("aria-invalid");
      error.textContent = "";
    });

    return h(
      "div",
      { class: "modal__inner" },
      h(
        "div",
        { class: "modal__body scroll" },
        h("div", { class: "modal__eyebrow", text: "Ministry" }),
        h("h2", { class: "modal__title", text: "Post a need" }),
        h("p", { class: "modal__lede", text: "Tell the network what you need. It appears on the globe immediately." }),
        h(
          "div",
          { class: "form" },
          field("Ministry", ministry),
          field("What do you need?", title),
          h("div", { class: "row2" }, field("Type", type), field("Urgency", urgency)),
          h("div", { class: "row2" }, field("People needed", people), field("Commitment", commitment)),
          field("Skills (comma separated)", skills),
          field("Details", detail),
          h(
            "label",
            { class: "check" },
            remote,
            h("span", { class: "check__box" }, icons.check()),
            "Can be done remotely",
          ),
        ),
      ),
      h(
        "div",
        { class: "modal__foot" },
        h("button", { class: "btn btn--accent", onclick: publish }, "Publish need"),
        h("button", { class: "btn btn--soft", onclick: close }, "Cancel"),
        error,
      ),
    );
  }, { width: 620 });
}

/* ----------------------------------------------------------- need detail */

export function needModal(layer, need, { onPickUp, onMinistry, onDrop, onSchedule }, { side = false } = {}) {
  return layer.show((close) => {
    const cell = (label, value) =>
      h("div", { class: "detail__cell" }, h("div", { class: "ml", text: label }), h("strong", { text: value }));

    const pick = h(
      "button",
      {
        class: need.taken ? "btn btn--soft" : "btn btn--accent",
        onclick: () => {
          if (need.taken) onDrop(need);
          else onPickUp(need);
          close();
        },
      },
      need.taken ? "Withdraw interest" : "Pick this up",
    );

    return h(
      "div",
      { class: "modal__inner" },
      h(
        "div",
        { class: "modal__body scroll" },
        h(
          "div",
          { class: "detail__head" },
          h("span", { class: `dot dot--${need.urgency}` }),
          h("span", { class: "modal__eyebrow", text: TYPE_BY_ID.get(need.type)?.label ?? need.type }),
          need.remote ? h("span", { class: "badge badge--remote", text: "Remote OK" }) : null,
        ),
        h("h2", { class: "detail__title", text: need.title }),
        h(
          "div",
          { class: "detail__ministry" },
          h("button", { onclick: () => { onMinistry(need); close(); } }, need.ministryName),
          ` · ${need.city}, ${need.country} · posted ${since(need.posted)}`,
        ),
        h(
          "div",
          { class: "detail__grid" },
          cell("Urgency", URGENCY_BY_ID.get(need.urgency)?.label ?? need.urgency),
          cell("People", need.people ? plural(need.people, "person", "people") : "Not people"),
          cell("Commitment", need.commitment || "Flexible"),
          cell("Focus", FOCUS_BY_ID.get(need.focus)?.label ?? "—"),
        ),
        h("div", { class: "prose" }, h("p", { text: need.detail || "No further detail was given." })),
        need.skills?.length
          ? h(
              "div",
              { class: "tags" },
              need.skills.map((s) => h("span", { class: "tag", text: s })),
            )
          : null,
      ),
      h(
        "div",
        { class: "modal__foot" },
        onSchedule
          ? h("button", { class: "btn btn--accent", onclick: () => { close(); onSchedule(need); } }, "Schedule a call")
          : null,
        // With a call on offer, that is the primary action; interest steps back.
        (onSchedule && pick.classList.replace("btn--accent", "btn--soft"), pick),
        h("button", { class: "btn btn--soft", onclick: () => { onMinistry(need); close(); } }, "See the ministry"),
        h("span", { class: "modal__note spacer", text: "Saved in this browser only." }),
      ),
    );
  }, { width: 600, side });
}


/* --------------------------------------------------------------- meetings */

const pad = (n) => String(n).padStart(2, "0");
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/**
 * Book a first call about a need: a day, a time, how long, and a line to the
 * ministry. The server creates the Google Meet and sends both invitations;
 * this shows the link as soon as it exists.
 */
export function scheduleModal(layer, need, { onBook }) {
  return layer.show((close) => {
    const field = (label, control) =>
      h("div", { class: "field" }, h("span", { class: "ml", text: label }), control);

    const tomorrow = new Date(Date.now() + 86_400_000);
    const date = h("input", {
      class: "input",
      type: "date",
      value: localDate(tomorrow),
      min: localDate(new Date()),
      max: localDate(new Date(Date.now() + 89 * 86_400_000)),
      "data-autofocus": true,
    });
    const time = h("input", { class: "input", type: "time", value: "10:00", step: 900 });
    let minutes = 30;
    const seg = h(
      "div",
      { class: "gate__seg seg-inline" },
      [15, 30, 45].map((m) =>
        h("button", {
          type: "button",
          class: m === minutes ? "is-on" : "",
          onclick: (e) => {
            minutes = m;
            for (const b of seg.children) b.classList.toggle("is-on", b === e.currentTarget);
          },
        }, `${m} min`),
      ),
    );
    const note = h("textarea", {
      class: "area",
      placeholder: `Hi, I'd love to help with "${need.title}". A little about me…`,
    });
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone.replace(/_/g, " ");
    const error = h("span", { class: "modal__note", style: { color: "var(--urgent)" } });
    const book = h("button", { class: "btn btn--accent" }, "Book the call");
    const body = h("div", { class: "modal__body scroll" });

    const success = (res) => {
      const when = new Date(res.meeting.starts_at);
      body.replaceChildren(
        h("div", { class: "modal__eyebrow", text: "Call booked" }),
        h("h2", { class: "modal__title", text: "You're meeting " + need.ministryName }),
        h("p", {
          class: "modal__lede",
          text: `${when.toLocaleString(undefined, { weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit" })} · ${res.meeting.duration_min} minutes. Google Calendar invitations are on their way to you and the ministry.`,
        }),
        res.meetUrl
          ? h("a", { class: "meet-link", href: res.meetUrl, target: "_blank", rel: "noopener" },
              h("span", { class: "meet-link__ico", text: "▶" }),
              h("span", {}, h("b", { text: "Google Meet" }), h("span", { text: res.meetUrl.replace(/^https?:\/\//, "") })),
            )
          : null,
      );
      foot.replaceChildren(
        res.meetUrl ? h("a", { class: "btn btn--accent", href: res.meetUrl, target: "_blank", rel: "noopener" }, "Open Google Meet") : null,
        h("button", { class: "btn btn--soft", onclick: close }, "Done"),
      );
    };

    book.addEventListener("click", async () => {
      const start = new Date(`${date.value}T${time.value}`);
      if (isNaN(start.getTime())) return (error.textContent = "Pick a day and a time.");
      if (start.getTime() < Date.now() + 10 * 60_000) return (error.textContent = "Pick a time at least ten minutes from now.");
      error.textContent = "";
      book.disabled = true;
      book.textContent = "Creating the call…";
      try {
        success(await onBook({ needId: need.id, startsAt: start.toISOString(), durationMin: minutes, note: note.value.trim() }));
      } catch (e) {
        error.textContent = e.message || "Something went wrong. Please try again.";
        book.disabled = false;
        book.textContent = "Book the call";
      }
    });

    body.append(
      h("div", { class: "modal__eyebrow", text: "First call" }),
      h("h2", { class: "modal__title", text: "Meet " + need.ministryName }),
      h("p", { class: "modal__lede", text: `A short video call about "${need.title}". We'll create a Google Meet and send you both an invitation.` }),
      h("div", { class: "form" },
        h("div", { class: "row2" }, field("Day", date), field("Time", time)),
        h("div", { class: "modal__note", text: `Times are in your time zone (${zone}).` }),
        field("Length", seg),
        field("Message to the ministry (optional)", note),
      ),
    );
    const foot = h("div", { class: "modal__foot" }, book, h("button", { class: "btn btn--soft", onclick: close }, "Cancel"), error);
    return h("div", { class: "modal__inner" }, body, foot);
  }, { width: 560 });
}

/** The signed-in person's upcoming calls. */
export function meetingsModal(layer, { load, onOpenNeed }) {
  return layer.show((close) => {
    const list = h("div", { class: "calls" }, h("p", { class: "modal__lede", text: "Loading…" }));
    load().then(
      (calls) => {
        if (!calls.length) {
          list.replaceChildren(h("p", { class: "modal__lede", text: "No calls booked yet. Open a need and choose “Schedule a call”." }));
          return;
        }
        list.replaceChildren(
          ...calls.map((c) => {
            const when = new Date(c.startsAt);
            return h("div", { class: "call" },
              h("div", { class: "call__when" },
                h("b", { text: when.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }) }),
                h("span", { text: when.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) + ` · ${c.minutes} min` }),
              ),
              h("button", { class: "call__what", onclick: () => { close(); onOpenNeed(c.needId); } },
                h("b", { text: c.needTitle }), h("span", { text: c.ministryName }),
              ),
              c.meetUrl ? h("a", { class: "btn btn--soft", href: c.meetUrl, target: "_blank", rel: "noopener" }, "Join") : null,
            );
          }),
        );
      },
      (e) => list.replaceChildren(h("p", { class: "modal__lede", text: e.message })),
    );
    return h("div", { class: "modal__inner" },
      h("div", { class: "modal__body scroll" },
        h("div", { class: "modal__eyebrow", text: "Your calls" }),
        h("h2", { class: "modal__title", text: "Upcoming calls" }),
        list,
      ),
    );
  }, { width: 560 });
}
