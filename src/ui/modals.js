/**
 * Dialogs. One layer, one at a time, closed by scrim, Escape or the corner x.
 */
import { add, h, icons, plural, since } from "./dom.js";
import { FOCUS_BY_ID, NEED_TYPES, TYPE_BY_ID, URGENCIES, URGENCY_BY_ID } from "../data/taxonomy.js";
import { MINISTRIES, MINISTRY_BY_ID } from "../data/ministries.js";

const SIDE_ROOM = window.matchMedia("(min-width: 1000px)");

/** A phone held upright, where a dialog is a bottom sheet (modal.css). */
const PHONE_SHEET = window.matchMedia("(max-width: 720px)");

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
    document.body.classList.remove("side-card");
    scrim.classList.add("is-out");
    modal.classList.add("is-out");
    this.onToggle?.(false);
    // On the card's own exit, not a child's; and on a timer as well, since a
    // card that never animates out would otherwise leave its scrim standing
    // over the globe, taking every drag.
    const done = () => {
      scrim.remove();
      modal.remove();
    };
    modal.addEventListener("animationend", (e) => e.target === modal && done());
    setTimeout(done, 600);
  }

  /**
   * On a phone a dialog is a sheet (modal.css), and a sheet is dismissed the
   * way every sheet on the phone is: pulled down. From the handle at any
   * time, and from the content once it is scrolled to the top — a downward
   * drag there has nothing left to scroll, so it can only mean "away".
   */
  #pullToClose(modal) {
    const grab = h("div", { class: "modal__grab", "aria-hidden": "true" });
    modal.prepend(grab);
    // Touch events rather than pointer events: once a list starts scrolling
    // natively the browser cancels the pointer stream, and only a
    // non-passive touchmove can take the gesture over from the scroller.
    let y0 = 0;
    let dy = 0;
    let t0 = 0;
    let armed = false;
    let live = false;
    const scrolledDown = (el) => {
      for (let n = el; n && n !== modal; n = n.parentElement) {
        if (n.scrollTop > 0) return true;
      }
      return false;
    };
    modal.addEventListener("touchstart", (e) => {
      armed = false;
      if (e.touches.length !== 1) return;
      const t = e.target;
      if (t.closest("input, textarea, select, [contenteditable]")) return;
      if (!t.closest(".modal__grab") && scrolledDown(t)) return;
      armed = true;
      live = false;
      y0 = e.touches[0].clientY;
      t0 = e.timeStamp;
      dy = 0;
    }, { passive: true });
    modal.addEventListener("touchmove", (e) => {
      if (!armed) return;
      dy = e.touches[0].clientY - y0;
      if (!live) {
        // An upward move is the content's to scroll; a plain downward one,
        // with nothing above to scroll back to, is the sheet's.
        if (dy < -4) return void (armed = false);
        if (dy < 8) return;
        live = true;
        modal.classList.add("is-dragging");
      }
      e.preventDefault();
      modal.style.translate = `0 ${Math.max(0, dy - 8)}px`;
    }, { passive: false });
    const end = (e) => {
      if (!armed) return;
      armed = false;
      if (!live) return;
      live = false;
      const speed = dy / Math.max(e.timeStamp - t0, 1);
      if (dy > 110 || speed > 0.6) {
        // Leave from where the finger let go, not from the top.
        modal.style.transition = "translate 0.22s ease-in";
        modal.style.translate = "0 100%";
        setTimeout(() => this.current?.modal === modal && this.close(), 200);
      } else {
        modal.style.transition = "translate 0.3s cubic-bezier(0.32, 0.72, 0, 1)";
        modal.style.translate = "";
        setTimeout(() => {
          modal.style.transition = "";
          modal.classList.remove("is-dragging");
        }, 320);
      }
    };
    modal.addEventListener("touchend", end);
    modal.addEventListener("touchcancel", end);
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
    if (PHONE_SHEET.matches) this.#pullToClose(modal);
    this.root.append(scrim, modal);
    this.current = { scrim, modal, side };
    document.body.classList.toggle("side-card", side);
    this.onToggle?.(true);
    const focusTarget =
      modal.querySelector("[data-autofocus]") ??
      modal.querySelector("input,select,textarea,button:not(.modal__x)");
    // Not on a phone: focusing a field there throws the keyboard up over the
    // sheet before anyone has read it, and focusing a link draws a ring
    // round it that a finger never asked for. The sheet itself takes focus.
    if (PHONE_SHEET.matches) {
      modal.tabIndex = -1;
      modal.focus({ preventScroll: true });
    } else {
      focusTarget?.focus({ preventScroll: true });
    }
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

export function needModal(layer, need, { onPickUp, onMinistry, onDrop, onSchedule, onEdit }, { side = false } = {}) {
  return layer.show((close) => {
    const cell = (label, value) =>
      h("div", { class: "detail__cell" }, h("div", { class: "ml", text: label }), h("strong", { text: value }));

    const pick = h(
      "button",
      {
        // The one action the card exists for: blue like every primary, going
        // green under the pointer as the moment of saying yes (modal.css).
        class: need.taken ? "btn btn--soft" : "btn btn--accent btn--serve",
        onclick: () => {
          // Close first: picking up opens the application in this same layer.
          close();
          if (need.taken) onDrop(need);
          else onPickUp(need);
        },
      },
      need.taken ? "Withdraw interest" : "Serve",
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
        // Up with the name it belongs to, rather than as a third action at
        // the foot competing with the two that answer the need.
        h("div", { class: "detail__links" },
          h("button", { class: "btn btn--soft btn--sm", onclick: () => { onMinistry(need); close(); } }, "See the ministry"),
          // The ministry's own need: the way back into it to change anything.
          onEdit ? h("button", { class: "btn btn--soft btn--sm", onclick: () => { close(); onEdit(need); } }, icons.edit(), "Edit") : null,
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
        // Picking it up leads; a call is the gentler second step beside it.
        pick,
        onSchedule
          ? h("button", { class: "btn btn--soft", onclick: () => { close(); onSchedule(need); } }, "Schedule a call")
          : null,
        h("span", { class: "modal__note spacer", text: "Saved in this browser only." }),
      ),
    );
  }, { width: 600, side });
}

/* ------------------------------------------------------------- pick it up */

/** What to ask, by the kind of need — a designer and a donor show different work. */
const ASK = {
  volunteers: {
    why: "Why do you want to serve here?",
    quals: "What experience do you have with this kind of work?",
    qualsHint: "Similar roles, how long you've done it, anything you've led.",
    work: "Anything that shows you've done this before — a lesson plan, a recording, photos, a reference.",
  },
  expertise: {
    why: "Why do you want to take this on?",
    quals: "What qualifies you for it?",
    qualsHint: "Training, certifications, years in the field, similar projects.",
    work: "Samples of similar work: a portfolio, a case study, a finished piece.",
  },
  supplies: {
    why: "Why do you want to provide this?",
    quals: "What can you supply, and how would it reach them?",
    qualsHint: "Quantities, where it ships from, how you've supplied before.",
    work: "Photos, a spec sheet or a quote for what you can send.",
  },
  funding: {
    why: "Why do you want to support this?",
    quals: "How would you fund or raise it?",
    qualsHint: "Giving directly, a church or foundation, a campaign you'd run.",
    work: "A past campaign, grant or giving page you've been part of.",
  },
  partners: {
    why: "Why does your organisation want to partner on this?",
    quals: "What does your organisation bring?",
    qualsHint: "Who you are, what you do, and the people you'd involve.",
    work: "Your website, an annual report or a past partnership.",
  },
};

const MAX_FILES = 5;
const MAX_BYTES = 20 * 1024 * 1024;
const ACCEPT = ".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt,.md,.png,.jpg,.jpeg,.gif,.webp,.svg,.mp3,.m4a,.mp4,.mov,.zip";

const fileSize = (n) =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

/**
 * The application behind "Serve": why, what qualifies you, and
 * previous work as links or files. Files need somewhere to go, so without a
 * sign-in (`canUpload` false) only links are offered.
 */
export function pickUpModal(layer, need, { canUpload, onSignIn, onSubmit }) {
  return layer.show((close) => {
    const ask = ASK[need.type] ?? ASK.volunteers;
    const field = (label, control, note) =>
      h("div", { class: "field" }, h("span", { class: "ml", text: label }), control, note ? h("span", { class: "field__note", text: note }) : null);

    const why = h("textarea", {
      class: "area",
      "data-autofocus": true,
      placeholder: `What draws you to "${need.title}"?`,
    });
    const quals = h("textarea", {
      class: "area",
      placeholder: need.skills?.length ? `They're looking for ${need.skills.join(", ")}.` : ask.qualsHint,
    });

    /* previous work: one list, fed by either a link or files */
    const links = [];
    const files = [];
    const items = h("div", { class: "work__items" });
    const renderItems = () => {
      items.replaceChildren(
        ...links.map((url, i) =>
          h("div", { class: "work__item" },
            h("span", { class: "work__kind", text: "Link" }),
            h("a", { class: "work__name", href: url, target: "_blank", rel: "noopener", text: url.replace(/^https?:\/\//, "") }),
            h("button", { class: "work__x", type: "button", "aria-label": "Remove link", onclick: () => { links.splice(i, 1); renderItems(); } }, icons.close()),
          ),
        ),
        ...files.map((f, i) =>
          h("div", { class: "work__item" },
            h("span", { class: "work__kind", text: "File" }),
            h("span", { class: "work__name", text: f.name }),
            h("span", { class: "work__size", text: fileSize(f.size) }),
            h("button", { class: "work__x", type: "button", "aria-label": `Remove ${f.name}`, onclick: () => { files.splice(i, 1); renderItems(); } }, icons.close()),
          ),
        ),
      );
    };

    const workError = h("span", { class: "field__note work__err" });
    const linkInput = h("input", { class: "input", type: "url", placeholder: "https://…", autocomplete: "off" });
    const addLink = () => {
      let url = linkInput.value.trim();
      if (!url) return;
      if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
      try {
        new URL(url);
      } catch {
        workError.textContent = "That doesn't look like a link.";
        return;
      }
      if (!links.includes(url)) links.push(url);
      linkInput.value = "";
      workError.textContent = "";
      renderItems();
    };
    linkInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        addLink();
      }
    });
    const linkPane = h("div", { class: "work__link" },
      linkInput,
      h("button", { class: "btn btn--soft", type: "button", onclick: addLink }, "Add link"),
    );

    const picker = h("input", { type: "file", multiple: true, accept: ACCEPT, hidden: true });
    const takeFiles = (list) => {
      workError.textContent = "";
      for (const f of list) {
        if (files.length >= MAX_FILES) {
          workError.textContent = `Up to ${MAX_FILES} files.`;
          break;
        }
        if (f.size > MAX_BYTES) {
          workError.textContent = `${f.name} is over 20 MB — share it as a link instead.`;
          continue;
        }
        if (!files.some((x) => x.name === f.name && x.size === f.size)) files.push(f);
      }
      picker.value = "";
      renderItems();
    };
    picker.addEventListener("change", () => takeFiles(picker.files));
    const drop = h("button", { class: "work__drop", type: "button", onclick: () => picker.click() },
      icons.plus(),
      h("b", { text: "Choose files" }),
      h("span", { text: "or drop them here · PDF, images, documents, audio or video · up to 20 MB each" }),
    );
    for (const ev of ["dragenter", "dragover"]) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("is-over"); });
    for (const ev of ["dragleave", "drop"]) drop.addEventListener(ev, () => drop.classList.remove("is-over"));
    drop.addEventListener("drop", (e) => {
      e.preventDefault();
      takeFiles(e.dataTransfer.files);
    });
    const filePane = canUpload
      ? h("div", {}, drop, picker)
      : h("div", { class: "work__locked" },
          h("span", { text: "Sign in to upload files. Links work either way." }),
          onSignIn ? h("button", { class: "btn btn--soft btn--sm", type: "button", onclick: () => { close(); onSignIn(); } }, "Sign in") : null,
        );

    let mode = "link";
    const panes = h("div", { class: "work__pane" }, linkPane);
    const seg = h("div", { class: "gate__seg seg-inline work__seg" },
      [["link", "Add a link"], ["file", "Upload files"]].map(([id, label]) =>
        h("button", {
          type: "button",
          class: id === mode ? "is-on" : "",
          onclick: (e) => {
            mode = id;
            for (const b of seg.children) b.classList.toggle("is-on", b === e.currentTarget);
            panes.replaceChildren(id === "link" ? linkPane : filePane);
            workError.textContent = "";
            (id === "link" ? linkInput : drop).focus?.();
          },
        }, label),
      ),
    );
    const workBox = h("div", { class: "work__box", hidden: true }, seg, panes, workError);
    const open = h("button", {
      class: "btn btn--soft work__open",
      type: "button",
      onclick: () => {
        workBox.hidden = false;
        open.hidden = true;
        linkInput.focus();
      },
    }, icons.plus(), "Upload previous work");

    /* submit */
    const error = h("span", { class: "modal__note", style: { color: "var(--urgent)" } });
    const send = h("button", { class: "btn btn--accent" }, "Send to " + need.ministryName);
    for (const el of [why, quals]) {
      el.addEventListener("input", () => {
        el.removeAttribute("aria-invalid");
        error.textContent = "";
      });
    }

    send.addEventListener("click", async () => {
      // A link typed but not added is almost always meant to be sent.
      if (linkInput.value.trim()) addLink();
      for (const [el, msg] of [[why, "Say a little about why you want to serve here."], [quals, "Tell them what qualifies you."]]) {
        if (el.value.trim().length < 10) {
          el.setAttribute("aria-invalid", "true");
          el.focus();
          error.textContent = msg;
          return;
        }
      }
      error.textContent = "";
      send.disabled = true;
      send.textContent = files.length ? "Uploading…" : "Sending…";
      try {
        await onSubmit({ why: why.value.trim(), qualifications: quals.value.trim(), links: [...links], files: [...files] });
        close();
      } catch (e) {
        error.textContent = e.message || "Something went wrong. Please try again.";
        send.disabled = false;
        send.textContent = "Send to " + need.ministryName;
      }
    });

    return h("div", { class: "modal__inner" },
      h("div", { class: "modal__body scroll" },
        h("div", { class: "modal__eyebrow", text: "Serve" }),
        h("h2", { class: "modal__title", text: need.title }),
        h("p", { class: "modal__lede", text: `A few questions so ${need.ministryName} knows who you are. They'll see your answers alongside your profile.` }),
        h("div", { class: "form" },
          field(ask.why, why),
          field(ask.quals, quals, need.skills?.length ? ask.qualsHint : null),
          h("div", { class: "field" },
            h("span", { class: "ml", text: "Previous work (optional)" }),
            h("span", { class: "field__note", text: ask.work }),
            open,
            workBox,
            items,
          ),
        ),
      ),
      h("div", { class: "modal__foot" },
        send,
        h("button", { class: "btn btn--soft", onclick: close }, "Cancel"),
        error,
      ),
    );
  }, { width: 600 });
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
