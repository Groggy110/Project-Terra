/**
 * The five questions, one at a time.
 *
 * One per screen rather than a single long form: the answers are the only
 * thing the recommender ever learns about a person, so the cost of someone
 * skimming and leaving half of them blank is bad suggestions for as long as
 * they use the site. A stepped form asks less at once and gets fuller answers.
 *
 * And within a screen, the same argument again: the lists open with six and
 * grow on request (see chips.js). Twenty-four skills at once is a wall, and
 * the response to a wall is Skip.
 *
 * Every question can be skipped. A thin profile still ranks better than none,
 * and refusing to proceed would lose the person entirely.
 */
import { add, h, clear, icons, svg } from "./dom.js";
import { FOCUS_AREAS } from "../data/taxonomy.js";
import { chipGroup } from "./chips.js";
import { loadQuestionnaire, saveQuestionnaire, clearRecommendationCache } from "../lib/api.js";

// Everything on Terra is done online, so these are skills that travel over a
// video call or a shared document.
const SKILLS = [
  "Graphic design", "Web design", "Writing & editing", "Translation", "Human resources", "Accounting & bookkeeping",
  "Fundraising & grants", "Marketing & social media", "Video & photo editing", "Teaching & tutoring", "Counselling", "Legal advice",
  "Project management", "Data & spreadsheets", "IT support", "Software development", "Nursing & medical advice", "Theology",
  "Architecture & engineering", "Mentoring & coaching", "Research", "Music", "Administration", "Business & finance",
].map((label) => ({ id: label, label }));

const SKILL_IDS = new Set(SKILLS.map((s) => s.id));

/* The serve-mode cards had no mark of any kind, which left three paragraphs
   of similar length to be told apart by reading them. A glyph each is what
   makes the row scannable. */
const GLOBE = '<circle cx="12" cy="12" r="8.4"/><ellipse cx="12" cy="12" rx="3.6" ry="8.4"/><path d="M3.8 9.2h16.4M3.8 14.8h16.4"/>';
const PLANE = '<path d="M10.4 20.5l1.6-5.2 4.6-1.4-.6 5.4 1.7.5.9-6.4 3.3-1a1.7 1.7 0 0 0-.9-3.3l-2.9.9-3.1-5.6-1.7.5 1.7 5.9-4.6 1.4-2.3-2.7-1.3.4 1.6 3.3-1.6 3.3 1.3.4 2.3-2.7"/>';
const HOME = '<path d="M4 10.4 12 4l8 6.4V19a1.6 1.6 0 0 1-1.6 1.6H5.6A1.6 1.6 0 0 1 4 19z"/><path d="M9.6 20.6v-6h4.8v6"/>';

// What shape of help someone wants to give. Stored in serve_mode, which the
// matcher reads as a list of preferences.
const SERVE_MODES = [
  { id: "ongoing", label: "An ongoing role", note: "A few hours a week, for months", icon: HOME },
  { id: "project", label: "A one-off project", note: "A logo, a website, a report", icon: PLANE },
  { id: "advice", label: "Advice & mentoring", note: "Calls with a ministry's team", icon: GLOBE },
];

const AVAILABILITY = [
  "A few hours a week",
  "A day a week",
  "Several weeks, full time",
  "Three months or more",
  "A year or more",
].map((label) => ({ id: label, label }));

export function questionnaireModal(layer, { onSaved } = {}) {
  let step = 0;
  let answers = { skills: [], serve_mode: [], availability: "", causes: [], experience: "", languages: [], portfolio: "" };
  let loading = true;

  const modal = layer.show(() => shell(h("p", { class: "modal__note", text: "Loading…" })), { width: 580 });

  loadQuestionnaire()
    .then((existing) => {
      if (existing) {
        answers = {
          skills: existing.skills ?? [],
          serve_mode: existing.serve_mode ?? [],
          availability: existing.availability ?? "",
          causes: existing.causes ?? [],
          experience: existing.experience ?? "",
          languages: existing.languages ?? [],
          portfolio: existing.portfolio ?? "",
        };
      }
      loading = false;
      render();
    })
    .catch(() => { loading = false; render(); });

  const toggle = (list, value) => {
    const i = list.indexOf(value);
    if (i < 0) list.push(value);
    else list.splice(i, 1);
  };

  const steps = [
    {
      title: "What can you do?",
      sub: "Pick anything you have real experience in — this is the strongest signal we have for matching you.",
      body: () =>
        chipGroup({
          options: SKILLS,
          isOn: (id) => answers.skills.includes(id),
          onToggle: (id) => toggle(answers.skills, id),
          batch: 6,
          custom: {
            placeholder: "Something else — type it and press enter",
            values: () => answers.skills.filter((s) => !SKILL_IDS.has(s)),
            onAdd: (v) => { if (!answers.skills.includes(v)) answers.skills.push(v); },
            onRemove: (v) => toggle(answers.skills, v),
          },
        }),
    },
    {
      title: "How would you like to help?",
      sub: "Pick any that suit you. Everything on Terra happens online.",
      body: () =>
        h("div", { class: "quiz__cards" },
          SERVE_MODES.map((m) =>
            h("button", {
              type: "button",
              class: `quiz__card${answers.serve_mode.includes(m.id) ? " is-on" : ""}`,
              "aria-pressed": answers.serve_mode.includes(m.id) ? "true" : "false",
              onclick: (e) => {
                toggle(answers.serve_mode, m.id);
                const btn = e.currentTarget;
                const on = answers.serve_mode.includes(m.id);
                btn.classList.toggle("is-on", on);
                btn.setAttribute("aria-pressed", on ? "true" : "false");
              },
            },
              svg("0 0 24 24", m.icon, "quiz__card-ico"),
              h("span", { class: "quiz__card-text" },
                h("b", { text: m.label }),
                h("span", { text: m.note }),
              ),
              svg("0 0 16 16", '<path d="M3.6 8.5l2.8 2.8 5.9-6.6"/>', "quiz__card-tick"),
            ),
          ),
        ),
    },
    {
      title: "How much time can you give?",
      sub: "Roughly. Ministries would rather have a few hours you keep than a promise you cannot.",
      body: () =>
        chipGroup({
          options: AVAILABILITY,
          batch: AVAILABILITY.length,
          single: true,
          isOn: (id) => answers.availability === id,
          onToggle: (id) => { answers.availability = answers.availability === id ? "" : id; },
        }),
    },
    {
      title: "What do you care about?",
      sub: "The work you would most want to be part of, whatever your skills say.",
      body: () =>
        chipGroup({
          options: FOCUS_AREAS,
          isOn: (id) => answers.causes.includes(id),
          onToggle: (id) => toggle(answers.causes, id),
          batch: 6,
        }),
      // No free text here, deliberately. These twelve are the vocabulary the
      // matcher actually reasons over; a typed cause would look accepted and
      // then count for nothing, which is worse than not offering the box.
    },
    {
      title: "Tell ministries about yourself",
      sub: "Past experience, the languages you work in, and a link to your work if you have one. Ministries see this when you offer to help.",
      body: () =>
        h("div", { class: "form" },
          h("textarea", {
            class: "area", rows: 4, value: answers.experience,
            placeholder: "Ten years as an HR manager; designed logos for two local churches.",
            oninput: (e) => { answers.experience = e.target.value; },
          }),
          h("input", {
            class: "input", value: answers.languages.join(", "),
            placeholder: "Languages — English, Spanish",
            oninput: (e) => { answers.languages = e.target.value.split(",").map((x) => x.trim()).filter(Boolean); },
          }),
          h("input", {
            class: "input", type: "url", value: answers.portfolio,
            placeholder: "LinkedIn or portfolio link (optional)",
            oninput: (e) => { answers.portfolio = e.target.value.trim(); },
          }),
        ),
    },
  ];

  /** Body and footer in the dialog's own boxes, so the padding is the padding. */
  function shell(...body) {
    return h("div", { class: "modal__inner" }, h("div", { class: "modal__body scroll" }, ...body));
  }

  function render() {
    clear(modal);
    modal.appendChild(
      h("button", { class: "modal__x", "aria-label": "Close", onclick: () => layer.close() }, icons.close()),
    );
    if (loading) return modal.appendChild(shell(h("p", { class: "modal__note", text: "Loading…" })));

    const s = steps[step];
    const last = step === steps.length - 1;

    modal.appendChild(
      h("div", { class: "modal__inner" },
        h("div", { class: "quiz__rail" },
          steps.map((_, i) =>
            h("i", { class: `quiz__tick${i < step ? " is-done" : ""}${i === step ? " is-on" : ""}` }),
          ),
        ),
        h("div", { class: "modal__body scroll" },
          h("div", { class: "modal__eyebrow", text: `Question ${step + 1} of ${steps.length}` }),
          h("h2", { class: "modal__title", text: s.title }),
          h("p", { class: "modal__lede", text: s.sub }),
          h("div", { class: "quiz__body" }, s.body()),
        ),
        h("div", { class: "modal__foot quiz__nav" },
          step > 0
            ? h("button", { class: "btn btn--soft", onclick: () => { step--; render(); } }, icons.back(), "Back")
            : h("span"),
          h("div", { class: "spacer" }),
          h("button", { class: "btn btn--ghost", onclick: () => next() }, "Skip"),
          h("button", { class: "btn btn--accent", onclick: () => next() },
            last ? "Save and match me" : "Next",
            icons.arrow(),
          ),
        ),
      ),
    );
  }

  function next() {
    if (step === steps.length - 1) finish();
    else { step++; render(); }
  }

  async function finish() {
    clear(modal);
    modal.appendChild(shell(h("p", { class: "modal__note", text: "Saving…" })));
    try {
      await saveQuestionnaire(answers);
      // The cache is keyed on updated_at, which just changed; clearing is
      // belt and braces so the next panel open definitely re-ranks.
      clearRecommendationCache();
      layer.close();
      onSaved?.(answers);
    } catch (err) {
      clear(modal);
      modal.appendChild(
        shell(
          h("h2", { class: "modal__title", text: "Could not save" }),
          h("p", { class: "modal__lede", text: String(err.message ?? err) }),
          h("div", { class: "modal__foot" }, h("button", { class: "btn btn--accent", onclick: () => render() }, "Back")),
        ),
      );
    }
  }

  return modal;
}
