/**
 * The two things a ministry does: put itself on the map, and say what it needs.
 *
 * Posting goes through the edge function and can come back held for review, so
 * the confirmation has two shapes. The held one says so plainly and gives the
 * model's reason — a ministry that cannot see why it was held will assume the
 * site is broken and not come back.
 */
import { add, clear, h, icons, nf } from "./dom.js";
import { FOCUS_AREAS, NEED_TYPES, URGENCIES } from "../data/taxonomy.js";
import { chipGroup } from "./chips.js";
import { primePlaces, regionFor, resolvePlace, searchPlaces } from "../data/places.js";
import { createMinistry, postNeed } from "../lib/api.js";

const field = (label, control, note) =>
  h("div", { class: "field" },
    h("span", { class: "field__label", text: label }),
    control,
    note && h("span", { class: "field__note", text: note }),
  );

/** Body and footer in the dialog's own boxes, so the padding is the padding. */
const shell = (body, foot) =>
  h("div", { class: "modal__inner" },
    h("div", { class: "modal__body scroll" }, body),
    foot,
  );

/* -------------------------------------------------- put a ministry on the map */

export function ministryModal(layer, { onCreated } = {}) {
  primePlaces();

  return layer.show((close) => {
    const name = h("input", { class: "input", placeholder: "Mathare Hope Collective", "data-autofocus": true });
    const country = h("input", { class: "input", placeholder: "Kenya", autocomplete: "off" });
    const blurb = h("textarea", { class: "area", rows: 3, placeholder: "What you do, in a sentence or two." });
    const contact = h("input", { class: "input", type: "email", placeholder: "hello@your-ministry.org" });
    const website = h("input", { class: "input", type: "url", placeholder: "https://your-ministry.org" });
    const languages = h("input", { class: "input", placeholder: "English, Swahili" });

    const chosen = [];
    const focusWrap = chipGroup({
      options: FOCUS_AREAS,
      batch: 6,
      isOn: (id) => chosen.includes(id),
      onToggle: (id) => {
        const i = chosen.indexOf(id);
        if (i < 0) chosen.push(id);
        else chosen.splice(i, 1);
      },
    });

    /**
     * Where the pin goes, worked out from the city rather than typed.
     *
     * The form used to ask for latitude and longitude outright and tell you to
     * go and right-click a different website for them — which is a form
     * admitting it cannot do its job. The gazetteer behind the globe's own
     * city labels already knows where Nairobi is, so it answers instead. See
     * data/places.js.
     */
    let pin = null;
    const pinNote = h("p", { class: "pinnote" });

    const paintPin = () => {
      pinNote.className = "pinnote";
      if (!city.value.trim()) {
        pinNote.textContent = "Start typing a city and we will find the spot.";
        return;
      }
      if (!pin) {
        // Mid-word is not a failure. Going red on "Nair" tells someone they
        // have made a mistake while they are still halfway through not making
        // one, so the warning waits until the field is done with.
        if (document.activeElement === city) {
          pinNote.textContent = "Keep typing, then pick your city from the list.";
          return;
        }
        pinNote.classList.add("is-bad");
        pinNote.textContent = "We could not place that one. Pick a city from the list, or check the country spelling.";
        return;
      }
      if (pin.kind === "country") {
        pinNote.classList.add("is-soft");
        pinNote.textContent = `No exact match for that city, so the pin will sit at the centre of ${pin.country}. Pick from the list for the real spot.`;
        return;
      }
      pinNote.classList.add("is-good");
      pinNote.textContent = `Pin lands on ${pin.city}, ${pin.country}.`;
    };

    const resolve = async () => {
      pin = await resolvePlace(city.value, country.value);
      if (pin?.kind === "city" && !country.value.trim()) country.value = pin.country;
      paintPin();
    };

    const city = cityField({
      onBlur: () => paintPin(),
      onPick: (place) => {
        country.value = place.country;
        pin = { kind: "city", lat: place.lat, lon: place.lon, city: place.name, country: place.country };
        paintPin();
      },
      onType: resolve,
      countryOf: () => country.value,
    });
    country.addEventListener("input", resolve);
    paintPin();

    const err = h("span", { class: "modal__note", style: { color: "var(--urgent)" } });
    const go = h("button", { class: "btn btn--accent" }, "Put us on the map");

    go.addEventListener("click", async () => {
      if (!name.value.trim() || !city.value.trim() || !country.value.trim() || !blurb.value.trim() || !contact.value.trim()) {
        err.textContent = "Name, city, country, what you do and a contact email are needed.";
        return;
      }
      await resolve();
      if (!pin) {
        err.textContent = "We could not find that place. Pick a city from the suggestions.";
        return;
      }
      go.disabled = true;
      go.textContent = "Saving…";
      err.textContent = "";
      try {
        const m = await createMinistry({
          name: name.value.trim(),
          city: city.value.trim(),
          country: country.value.trim(),
          lat: pin.lat,
          lon: pin.lon,
          region: await regionFor(country.value),
          focus: chosen,
          blurb: blurb.value.trim(),
          contact: contact.value.trim(),
          website: website.value.trim() || null,
          languages: languages.value.split(",").map((x) => x.trim()).filter(Boolean),
        });
        close();
        onCreated?.(m);
      } catch (e) {
        err.textContent = String(e.message ?? e);
        go.disabled = false;
        go.textContent = "Put us on the map";
      }
    });

    return shell(
      [
        h("div", { class: "modal__eyebrow", text: "Set up your ministry" }),
        h("h2", { class: "modal__title", text: "Tell us about your ministry" }),
        h("p", { class: "modal__lede", text: "This becomes your pin on the globe, and it fills in every need you post. You can change it later." }),
        h("div", { class: "form" },
          field("Ministry name", name),
          h("div", { class: "row2" }, field("City", city.wrap), field("Country", country)),
          pinNote,
          field("What you do", blurb),
          h("div", { class: "row2" }, field("Contact email", contact), field("Website", website)),
          field("Languages you work in", languages),
          field("Focus areas", focusWrap, "Pick as many as fit — it is how people find you."),
        ),
      ],
      h("div", { class: "modal__foot" }, err, h("span", { class: "spacer" }), go),
    );
  }, { width: 620 });
}

/**
 * A city box that suggests as you type. The list is the same gazetteer the
 * globe letters its cities from, so anything it offers is somewhere the pin
 * can actually go.
 */
function cityField({ onPick, onType, onBlur, countryOf }) {
  const input = h("input", {
    class: "input",
    placeholder: "Nairobi",
    autocomplete: "off",
    spellcheck: "false",
    role: "combobox",
    "aria-expanded": "false",
    "aria-autocomplete": "list",
  });
  const menu = h("div", { class: "typeahead__menu", hidden: true });
  const wrap = h("div", { class: "typeahead" }, input, menu);

  let rows = [];
  let cursor = -1;
  let token = 0;

  const hide = () => {
    menu.hidden = true;
    input.setAttribute("aria-expanded", "false");
    cursor = -1;
  };

  const choose = (place) => {
    input.value = place.name;
    onPick(place);
    hide();
  };

  const paint = () => {
    clear(menu);
    if (!rows.length) return hide();
    rows.forEach((place, i) => {
      menu.appendChild(
        h("button", {
          type: "button",
          class: `typeahead__row${i === cursor ? " is-cursor" : ""}`,
          // mousedown, not click: blur fires first and would close the menu
          // out from under the pointer.
          onmousedown: (e) => { e.preventDefault(); choose(place); },
        },
          h("span", { class: "typeahead__name", text: place.name }),
          h("span", { class: "typeahead__where", text: place.country }),
          place.population > 0 && h("span", { class: "typeahead__pop", text: nf.format(place.population) }),
        ),
      );
    });
    menu.hidden = false;
    input.setAttribute("aria-expanded", "true");
  };

  input.addEventListener("input", async () => {
    onType?.();
    const mine = ++token;
    const found = await searchPlaces(input.value, { country: countryOf() });
    if (mine !== token) return; // a later keystroke already answered
    rows = found;
    cursor = -1;
    paint();
  });

  input.addEventListener("keydown", (e) => {
    if (menu.hidden || !rows.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      cursor = (cursor + (e.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length;
      paint();
    } else if (e.key === "Enter" && cursor >= 0) {
      e.preventDefault();
      choose(rows[cursor]);
    } else if (e.key === "Escape") {
      hide();
    }
  });

  input.addEventListener("blur", () => setTimeout(() => { hide(); onBlur?.(); }, 120));

  return Object.assign(input, { wrap });
}

/* --------------------------------------------------------------- post a need */

export function postNeedModal(layer, { ministry, onPosted } = {}) {
  return layer.show((close) => {
    const title = h("input", { class: "input", placeholder: "Part-time HR adviser", "data-autofocus": true });
    // Terra is for help given online, so the types are the two a person can be.
    const type = h("select", { class: "select" },
      NEED_TYPES.filter((t) => t.id === "expertise" || t.id === "volunteers").map((t) => h("option", { value: t.id }, `${t.label} — ${t.note.toLowerCase()}`)));
    const urgency = h("select", { class: "select" }, URGENCIES.map((u) => h("option", { value: u.id, selected: u.id === "soon" }, u.label)));
    const focus = h("select", { class: "select" },
      FOCUS_AREAS.map((f) => h("option", { value: f.id, selected: f.id === ministry.focus?.[0] }, f.label)));
    const people = h("input", { class: "input", type: "number", min: "0", max: "500", value: "1" });
    const commitment = h("input", { class: "input", placeholder: "3 hrs/week · 3 months" });
    const detail = h("textarea", { class: "area", rows: 4, placeholder: "What the work involves and why it matters." });

    const skills = [];
    const skillChips = chipGroup({
      options: [],
      batch: 0,
      isOn: () => false,
      onToggle: () => {},
      custom: {
        placeholder: "HR, Employment law — type and press enter",
        values: () => skills,
        onAdd: (v) => { if (!skills.includes(v)) skills.push(v); },
        onRemove: (v) => { const i = skills.indexOf(v); if (i >= 0) skills.splice(i, 1); },
      },
    });

    const err = h("span", { class: "modal__note", style: { color: "var(--urgent)" } });
    const go = h("button", { class: "btn btn--accent" }, "Post this need");

    go.addEventListener("click", async () => {
      if (!title.value.trim()) { err.textContent = "Give the need a title first."; return; }
      go.disabled = true; go.textContent = "Checking…"; err.textContent = "";
      try {
        const res = await postNeed({
          ministry_id: ministry.id,
          title: title.value.trim(),
          type: type.value,
          urgency: urgency.value,
          focus: focus.value,
          people: Math.max(0, Number(people.value) || 0),
          remote: true,
          commitment: commitment.value.trim(),
          skills: [...skills],
          detail: detail.value.trim(),
        });
        showResult(res);
      } catch (e) {
        err.textContent = String(e.message ?? e);
        go.disabled = false; go.textContent = "Post this need";
      }
    });

    const card = shell(
      [
        h("div", { class: "modal__eyebrow", text: "New need" }),
        h("h2", { class: "modal__title", text: "What do you need?" }),
        h("p", { class: "modal__lede", text: `Posting for ${ministry.name} — ${ministry.city}. Everything posted is checked before it appears on the globe.` }),
        h("div", { class: "form" },
          field("Title", title),
          h("div", { class: "row2" }, field("Type", type), field("Urgency", urgency)),
          h("div", { class: "row2" }, field("Focus area", focus), field("People wanted", people)),
          field("Commitment", commitment),
          field("Skills wanted", skillChips),
          field("Detail", detail),
        ),
      ],
      h("div", { class: "modal__foot" }, err, h("span", { class: "spacer" }), go),
    );

    function showResult(res) {
      clear(card);
      const held = res.status !== "live";
      add(card, [
        h("div", { class: "modal__body" },
          h("div", { class: `post-done${held ? " is-held" : ""}` },
            held ? icons.pin() : icons.check(),
            h("h2", { class: "modal__title", text: held ? "Posted for review" : "It is on the globe" }),
            h("p", { class: "modal__lede", text: res.message }),
            res.reason && h("p", { class: "post-done__why", text: res.reason }),
            held && h("p", { class: "modal__note", text: "You can see it in your own list meanwhile — it is only hidden from the public globe." }),
            h("button", { class: "btn btn--accent", onclick: () => { close(); onPosted?.(res); } }, "Done"),
          ),
        ),
      ]);
    }

    return card;
  }, { width: 620 });
}
