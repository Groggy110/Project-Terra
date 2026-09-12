/**
 * The five questions, one at a time.
 *
 * One per screen rather than a single long form: the answers are the only
 * thing the recommender ever learns about a person, so the cost of someone
 * skimming and leaving half of them blank is bad suggestions for as long as
 * they use the site. A stepped form asks less at once and gets fuller answers.
 *
 * Every question can be skipped. A thin profile still ranks better than none,
 * and refusing to proceed would lose the person entirely.
 */
import { add, h, clear, icons } from "./dom.js";
import { FOCUS_AREAS } from "../data/taxonomy.js";
import { loadQuestionnaire, saveQuestionnaire, clearRecommendationCache } from "../lib/api.js";

const SKILLS = [
  "Nursing", "Medicine", "Teaching", "Childcare", "Counselling", "Trauma care",
  "Translation", "Theology", "Construction", "Engineering", "Plumbing", "Electrics",
  "Logistics", "Driving", "Accounting", "Fundraising", "Legal", "Social work",
  "Software", "Design", "Photography", "Agriculture", "Water & sanitation", "Cooking",
];

const SERVE_MODES = [
  { id: "remote", label: "Remotely", note: "From wherever I am" },
  { id: "on-site", label: "On site", note: "I can travel and stay" },
  { id: "local", label: "Near me", note: "In my own city or region" },
];

const AVAILABILITY = [
  "A few hours a week",
  "A day a week",
  "Several weeks, full time",
  "Three months or more",
  "A year or more",
];

export function questionnaireModal(layer, { onSaved } = {}) {
  let step = 0;
  let answers = { skills: [], serve_mode: [], availability: "", causes: [], experience: "" };
  let loading = true;

  const modal = layer.show(() => h("div", { class: "quiz" }, h("p", { class: "modal__note", text: "Loading…" })), { width: 560 });

  loadQuestionnaire()
    .then((existing) => {
      if (existing) {
        answers = {
          skills: existing.skills ?? [],
          serve_mode: existing.serve_mode ?? [],
          availability: existing.availability ?? "",
          causes: existing.causes ?? [],
          experience: existing.experience ?? "",
        };
      }
      loading = false;
      render();
    })
    .catch(() => { loading = false; render(); });

  const toggle = (list, value) => {
    const i = list.indexOf(value);
    if (i < 0) list.push(value); else list.splice(i, 1);
    render();
  };

  const chip = (value, on, onClick) =>
    h("button", { type: "button", class: `quiz__chip${on ? " is-on" : ""}`, onclick: onClick, text: value });

  const steps = [
    {
      title: "What can you do?",
      sub: "Pick anything you have real experience in. This is the strongest signal we have for matching you.",
      body: () => h("div", { class: "quiz__chips" },
        SKILLS.map((s) => chip(s, answers.skills.includes(s), () => toggle(answers.skills, s))),
      ),
      extra: () => h("input", {
        class: "input", placeholder: "Anything else, comma separated",
        value: answers.skills.filter((s) => !SKILLS.includes(s)).join(", "),
        oninput: (e) => {
          const custom = e.target.value.split(",").map((s) => s.trim()).filter(Boolean);
          answers.skills = [...answers.skills.filter((s) => SKILLS.includes(s)), ...custom];
        },
      }),
    },
    {
      title: "How would you like to serve?",
      sub: "Be honest here — a need you cannot physically reach is not a match, however well your skills fit.",
      body: () => h("div", { class: "quiz__cards" },
        SERVE_MODES.map((m) =>
          h("button", {
            type: "button",
            class: `quiz__card${answers.serve_mode.includes(m.id) ? " is-on" : ""}`,
            onclick: () => toggle(answers.serve_mode, m.id),
          }, h("b", { text: m.label }), h("span", { text: m.note })),
        ),
      ),
    },
    {
      title: "How much time can you give?",
      sub: "Roughly. Ministries would rather have a few hours you keep than a promise you cannot.",
      body: () => h("div", { class: "quiz__chips" },
        AVAILABILITY.map((a) => chip(a, answers.availability === a, () => { answers.availability = answers.availability === a ? "" : a; render(); })),
      ),
    },
    {
      title: "What do you care about?",
      sub: "The work you would most want to be part of, whatever your skills say.",
      body: () => h("div", { class: "quiz__chips" },
        FOCUS_AREAS.map((f) => chip(f.label, answers.causes.includes(f.id), () => toggle(answers.causes, f.id))),
      ),
    },
    {
      title: "Have you done anything like this before?",
      sub: "A sentence or two is plenty. Leave it blank if not — everyone starts somewhere.",
      body: () => h("textarea", {
        class: "area", rows: 5, value: answers.experience,
        placeholder: "Two summers running a youth camp; a year on a hospital ward in Nairobi.",
        oninput: (e) => { answers.experience = e.target.value; },
      }),
    },
  ];

  function render() {
    const card = modal.querySelector(".quiz") ?? modal;
    clear(card);
    if (loading) return add(card, [h("p", { class: "modal__note", text: "Loading…" })]);

    const s = steps[step];
    const last = step === steps.length - 1;

    add(card, [
      h("div", { class: "quiz__rail" },
        steps.map((_, i) => h("i", { class: `quiz__tick${i <= step ? " is-on" : ""}` })),
      ),
      h("div", { class: "ml", text: `Question ${step + 1} of ${steps.length}` }),
      h("h2", { class: "modal__title", text: s.title }),
      h("p", { class: "modal__lede", text: s.sub }),
      h("div", { class: "quiz__body" }, s.body(), s.extra?.()),
      h("div", { class: "quiz__nav" },
        step > 0
          ? h("button", { class: "btn btn--soft", onclick: () => { step--; render(); } }, icons.back(), "Back")
          : h("span"),
        h("div", { class: "quiz__nav-right" },
          h("button", { class: "btn btn--ghost", onclick: () => { if (last) finish(); else { step++; render(); } } }, "Skip"),
          h("button", {
            class: "btn btn--accent",
            onclick: () => { if (last) finish(); else { step++; render(); } },
          }, last ? "Save and match me" : "Next", icons.arrow()),
        ),
      ),
    ]);
  }

  async function finish() {
    const card = modal.querySelector(".quiz") ?? modal;
    clear(card);
    add(card, [h("p", { class: "modal__note", text: "Saving…" })]);
    try {
      await saveQuestionnaire(answers);
      // The cache is keyed on updated_at, which just changed; clearing is
      // belt and braces so the next panel open definitely re-ranks.
      clearRecommendationCache();
      layer.close();
      onSaved?.(answers);
    } catch (err) {
      clear(card);
      add(card, [
        h("h2", { class: "modal__title", text: "Could not save" }),
        h("p", { class: "modal__lede", text: String(err.message ?? err) }),
        h("button", { class: "btn btn--accent", onclick: () => render() }, "Back"),
      ]);
    }
  }

  return modal;
}
